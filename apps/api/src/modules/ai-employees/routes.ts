import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enforceLimit } from '../../shared/limits.js';
import type { Client } from '../../db/pool.js';
import { ACTIONS, ACTION_TYPES, CHANNELS, DIALECTS, LANGUAGES, TASKS, TASK_INFO, permissionsSchema, resolvePermissions } from '../../agent/catalog.js';
import { EMPLOYEE_COLUMNS, audit, behaviourSnapshot, configFingerprint, loadEmployee, type EmployeeProfile } from '../../agent/employee.js';
import { AppError, forbidden, notFound } from '../../shared/errors.js';
import { can } from '../../shared/permissions.js';

const idParam = z.object({ id: z.uuid() });
const profileShape = {
  name: z.string().trim().min(1).max(80),
  jobTitle: z.string().trim().max(120),
  description: z.string().trim().max(1000),
  personality: z.string().trim().max(2000),
  avatar: z.string().regex(/^[a-z]+-[0-9]{1,2}$/),
  language: z.enum(LANGUAGES),
  dialect: z.enum(DIALECTS),
  tasks: z.array(z.enum(TASKS)).max(TASKS.length).transform((a) => [...new Set(a)]),
  knowledgeMode: z.enum(['all', 'selected']),
  permissions: permissionsSchema,
  channels: z.array(z.enum(CHANNELS)).transform((a) => [...new Set(a)]),
  model: z.string().trim().min(3).max(100).nullable(),
};
const createBody = z.object({
  name: profileShape.name,
  jobTitle: profileShape.jobTitle.default(''),
  description: profileShape.description.default(''),
  personality: profileShape.personality.default(''),
  avatar: profileShape.avatar.default('bot-1'),
  language: profileShape.language.default('auto'),
  dialect: profileShape.dialect.default('none'),
  tasks: profileShape.tasks.default([]),
  knowledgeMode: profileShape.knowledgeMode.default('all'),
  permissions: profileShape.permissions.default({}),
  channels: profileShape.channels.default([]),
  model: profileShape.model.default(null),
});
const updateBody = z.object(profileShape).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const statusBody = z.object({ status: z.enum(['draft', 'active', 'paused']) });

const COLUMN_OF: Record<string, string> = {
  name: 'name', jobTitle: 'job_title', description: 'description', personality: 'personality', avatar: 'avatar', language: 'language', dialect: 'dialect',
  tasks: 'tasks', knowledgeMode: 'knowledge_mode', permissions: 'permissions', channels: 'channels', model: 'model',
};
const JSON_COLS = new Set(['permissions']);
/** Fields that decide what the employee is ALLOWED to do. */
const POWER_FIELDS = new Set(['permissions']);

export interface Readiness {
  ready: boolean;
  checks: Array<{ key: string; ok: boolean; blocking: boolean; message: string }>;
  fingerprint: string;
}

async function readiness(c: Client, e: EmployeeProfile, aiConfigured: boolean): Promise<Readiness> {
  const fingerprint = await configFingerprint(c, e);
  const { rows } = await c.query(`SELECT count(*)::int AS n FROM knowledge_items WHERE status = 'confirmed'`);
  const checks = [
    { key: 'tasks', ok: e.tasks.length > 0, blocking: true, message: 'Choose at least one task.' },
    { key: 'tested', ok: e.testedFingerprint === fingerprint, blocking: true, message: 'Run the simulation test suite and pass it for the current configuration.' },
    { key: 'knowledge', ok: (rows[0]?.n ?? 0) > 0, blocking: false, message: 'No confirmed business knowledge yet: the employee will have nothing to answer from.' },
    { key: 'ai', ok: aiConfigured, blocking: false, message: 'AI provider is not configured on the server.' },
  ];
  return { ready: checks.every((x) => x.ok || !x.blocking), checks, fingerprint };
}

async function snapshotVersion(c: Client, tenantId: string, userId: string, e: EmployeeProfile, summary: string): Promise<void> {
  await c.query(`INSERT INTO ai_employee_versions (tenant_id, employee_id, version, snapshot, summary, changed_by) VALUES ($1, $2, $3, $4, $5, $6)`, [
    tenantId, e.id, e.version, JSON.stringify(behaviourSnapshot({ ...e, permissions: e.permissions })), summary, userId,
  ]);
}

export async function aiEmployeeRoutes(app: FastifyInstance): Promise<void> {
  const read = [app.authenticate, app.requirePermission('ai_employees:read')];
  const write = [app.authenticate, app.requirePermission('ai_employees:write')];
  const power = [app.authenticate, app.requirePermission('ai_permissions:manage')];

  // ── catalog the UI needs to build forms (single source of truth lives in the backend)
  app.get('/ai/catalog', { preHandler: read }, async () => ({
    tasks: TASKS.map((key) => ({ key, ...TASK_INFO[key] })),
    actions: ACTION_TYPES.map((key) => ({ key, label: ACTIONS[key].label, description: ACTIONS[key].description, tasks: ACTIONS[key].tasks, defaultMode: ACTIONS[key].defaultMode, limit: ACTIONS[key].limit ?? null })),
    dialects: DIALECTS, languages: LANGUAGES, channels: CHANNELS,
    defaultModel: app.ai.defaultModel,
  }));
  app.get('/ai/models', { preHandler: read }, async () => ({ ...(await app.ai.listModels()), configured: app.ai.configured }));
  app.get('/ai/usage', { preHandler: [app.authenticate, app.requirePermission('audit:read')] }, async (req) => app.ai.usageSummary(req.auth!.tenantId!));

  app.get('/ai-employees', { preHandler: read }, async (req) => {
    const { rows } = await app.tenantTx(req, (c) => c.query(`SELECT ${EMPLOYEE_COLUMNS} FROM ai_employees ORDER BY created_at DESC LIMIT 200`));
    return { items: rows };
  });

  app.get('/ai-employees/:id', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    return app.tenantTx(req, async (c) => {
      const e = await loadEmployee(c, id);
      if (!e) throw notFound('AI Employee not found');
      const sources = (await c.query('SELECT source_id AS id FROM employee_sources WHERE employee_id = $1', [id])).rows.map((r) => r.id as string);
      return { ...e, effectivePermissions: resolvePermissions(e.permissions), sourceIds: sources, readiness: await readiness(c, e, app.ai.configured) };
    });
  });

  app.post('/ai-employees', { preHandler: write }, async (req, reply) => {
    const body = createBody.parse(req.body);
    if (Object.keys(body.permissions).length > 0 && !can(req.auth!.role, 'ai_permissions:manage')) throw forbidden('Only an owner or admin can set what an employee is allowed to do');
    if (body.model) app.ai.assertModelAllowed(body.model);
    const row = await app.tenantTx(req, async (c) => {
      await enforceLimit(c, req.auth!.tenantId!, 'maxAiEmployees');
      const { rows } = await c.query(
        `INSERT INTO ai_employees (tenant_id, name, job_title, description, personality, avatar, language, dialect, tasks, knowledge_mode, permissions, channels, model, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft',$14) RETURNING ${EMPLOYEE_COLUMNS}`,
        [req.auth!.tenantId, body.name, body.jobTitle, body.description, body.personality, body.avatar, body.language, body.dialect, body.tasks, body.knowledgeMode, JSON.stringify(body.permissions), body.channels, body.model, req.auth!.userId],
      );
      const e = rows[0] as EmployeeProfile;
      await snapshotVersion(c, req.auth!.tenantId!, req.auth!.userId, e, 'Created');
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'ai_employee.created', 'ai_employee', e.id);
      return e;
    });
    return reply.status(201).send(row);
  });

  app.patch('/ai-employees/:id', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = updateBody.parse(req.body);
    const changed = Object.keys(body);
    if (changed.some((k) => POWER_FIELDS.has(k)) && !can(req.auth!.role, 'ai_permissions:manage')) throw forbidden('Only an owner or admin can change what an employee is allowed to do');
    if (body.model) app.ai.assertModelAllowed(body.model);
    return app.tenantTx(req, async (c) => {
      const before = await loadEmployee(c, id);
      if (!before) throw notFound('AI Employee not found');
      const result = await applyChanges(c, req, before, body as Record<string, unknown>, `Edited: ${changed.join(', ')}`);
      return result;
    });
  });

  async function applyChanges(c: Client, req: Parameters<typeof app.tenantTx>[0], before: EmployeeProfile, patch: Record<string, unknown>, summary: string) {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(patch)) {
      const col = COLUMN_OF[key];
      if (!col || val === undefined) continue;
      values.push(JSON_COLS.has(col) ? JSON.stringify(val) : val);
      sets.push(`${col} = $${values.length}`);
    }
    if (!sets.length) return { ...before, requiresRetest: false };
    // Editing behaviour of a LIVE employee takes it offline until it passes the tests again.
    const demote = before.status === 'active';
    if (demote) sets.push(`status = 'paused'`);
    sets.push(`version = version + 1`);
    values.push(before.id);
    const { rows } = await c.query(`UPDATE ai_employees SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${EMPLOYEE_COLUMNS}`, values);
    const after = rows[0] as EmployeeProfile;
    await snapshotVersion(c, req.auth!.tenantId!, req.auth!.userId, after, summary);
    const permsChanged = 'permissions' in patch;
    await audit(c, req.auth!.tenantId!, req.auth!.userId, permsChanged ? 'ai_employee.permissions_changed' : 'ai_employee.updated', 'ai_employee', after.id, {
      version: after.version, fields: Object.keys(patch), pausedForRetest: demote,
      ...(permsChanged ? { from: resolvePermissions(before.permissions), to: resolvePermissions(after.permissions) } : {}),
    });
    return { ...after, requiresRetest: true, pausedForRetest: demote };
  }

  // ── status changes. Going live is gated by the simulation: it must have passed for THIS configuration.
  app.post('/ai-employees/:id/status', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { status } = statusBody.parse(req.body);
    return app.tenantTx(req, async (c) => {
      const e = await loadEmployee(c, id);
      if (!e) throw notFound('AI Employee not found');
      if (status === 'active') {
        if (!can(req.auth!.role, 'ai_permissions:manage')) throw forbidden('Only an owner or admin can activate an employee');
        const r = await readiness(c, e, app.ai.configured);
        const blocked = r.checks.filter((x) => x.blocking && !x.ok);
        if (blocked.length) throw new AppError(409, 'not_ready', 'This employee cannot go live yet', blocked.map((b) => ({ key: b.key, message: b.message })));
      }
      const { rows } = await c.query(`UPDATE ai_employees SET status = $1 WHERE id = $2 RETURNING ${EMPLOYEE_COLUMNS}`, [status, id]);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, `ai_employee.status_${status}`, 'ai_employee', id, { from: e.status });
      return rows[0];
    });
  });

  app.put('/ai-employees/:id/sources', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { sourceIds } = z.object({ sourceIds: z.array(z.uuid()).max(100) }).parse(req.body);
    return app.tenantTx(req, async (c) => {
      const e = await loadEmployee(c, id);
      if (!e) throw notFound('AI Employee not found');
      if (sourceIds.length) {
        // composite FKs would reject another tenant's source anyway; this gives a clean 400 instead of a 500
        const ok = await c.query('SELECT count(*)::int AS n FROM knowledge_sources WHERE id = ANY($1::uuid[])', [sourceIds]);
        if (ok.rows[0].n !== new Set(sourceIds).size) throw new AppError(400, 'unknown_source', 'One of the sources does not exist');
      }
      await c.query('DELETE FROM employee_sources WHERE employee_id = $1', [id]);
      for (const s of new Set(sourceIds)) await c.query('INSERT INTO employee_sources (tenant_id, employee_id, source_id) VALUES ($1,$2,$3)', [req.auth!.tenantId, id, s]);
      await c.query('UPDATE ai_employees SET version = version + 1 WHERE id = $1', [id]);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'ai_employee.sources_changed', 'ai_employee', id, { count: sourceIds.length });
      return { sourceIds: [...new Set(sourceIds)] };
    });
  });

  app.get('/ai-employees/:id/versions', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(`SELECT v.version, v.summary, v.created_at AS "createdAt", u.full_name AS "changedBy" FROM ai_employee_versions v LEFT JOIN users u ON u.id = v.changed_by WHERE v.employee_id = $1 ORDER BY v.version DESC LIMIT 100`, [id]),
    );
    return { items: rows };
  });

  app.get('/ai-employees/:id/versions/:version', { preHandler: read }, async (req) => {
    const p = z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) }).parse(req.params);
    const { rows } = await app.tenantTx(req, (c) => c.query(`SELECT version, snapshot, summary, created_at AS "createdAt" FROM ai_employee_versions WHERE employee_id = $1 AND version = $2`, [p.id, p.version]));
    if (!rows[0]) throw notFound('Version not found');
    return rows[0];
  });

  // Rollback = apply an old snapshot as a NEW version (history is never rewritten). Needs the higher permission.
  app.post('/ai-employees/:id/rollback', { preHandler: power }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { version } = z.object({ version: z.number().int().min(1) }).parse(req.body);
    return app.tenantTx(req, async (c) => {
      const before = await loadEmployee(c, id);
      if (!before) throw notFound('AI Employee not found');
      const { rows } = await c.query('SELECT snapshot FROM ai_employee_versions WHERE employee_id = $1 AND version = $2', [id, version]);
      if (!rows[0]) throw notFound('Version not found');
      const s = rows[0].snapshot as Record<string, unknown>;
      // permissions snapshots store the RESOLVED table; storing it back is equivalent to the defaults + overrides
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(COLUMN_OF)) if (k in s) patch[k] = s[k];
      const parsed = z.object(profileShape).partial().safeParse(patch);
      if (!parsed.success) throw new AppError(409, 'snapshot_invalid', 'That version can no longer be applied');
      return applyChanges(c, req, before, parsed.data as Record<string, unknown>, `Rolled back to version ${version}`);
    });
  });

  app.delete('/ai-employees/:id', { preHandler: write }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const deleted = await app.tenantTx(req, async (c) => {
      const res = await c.query('DELETE FROM ai_employees WHERE id = $1', [id]);
      if (res.rowCount) await audit(c, req.auth!.tenantId!, req.auth!.userId, 'ai_employee.deleted', 'ai_employee', id);
      return res.rowCount ?? 0;
    });
    if (!deleted) throw notFound('AI Employee not found');
    return reply.status(204).send();
  });
}
