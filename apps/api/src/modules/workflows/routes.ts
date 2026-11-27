import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../agent/employee.js';
import { AppError, notFound } from '../../shared/errors.js';
import { HANDLES, NODE_INFO, NODE_TYPES, STARTER_GRAPH, TRIGGER_KINDS, ACTION_KINDS, CONDITION_OPS, graphSchema, type Graph } from '../../workflows/graph.js';
import { RUN_COLS } from '../../workflows/engine.js';

const idParam = z.object({ id: z.uuid() });
const WF = `id, name, description, status, active_version_id AS "activeVersionId", latest_version AS "latestVersion", created_at AS "createdAt", updated_at AS "updatedAt"`;
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);
/** jsonb does not keep key order, so graphs are compared with sorted keys. */
const sameGraph = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  const E = app.workflows;
  const read = [app.authenticate, app.requirePermission('workflows:read')];
  const manage = [app.authenticate, app.requirePermission('workflows:manage')];
  const publish = [app.authenticate, app.requirePermission('workflows:publish')];
  const tasks = [app.authenticate, app.requirePermission('workflows:tasks')];

  app.get('/workflows/meta', { preHandler: read }, async () => ({
    nodes: NODE_TYPES.map((t) => ({ type: t, ...NODE_INFO[t], handles: HANDLES[t] })),
    triggerKinds: TRIGGER_KINDS, actionKinds: ACTION_KINDS, conditionOps: CONDITION_OPS,
    limits: { maxSteps: 200, maxLoopIterations: 100, maxDelayDays: 30, maxSubprocessDepth: 3, maxNodes: 60 },
    variables: ['trigger.message.text', 'trigger.platform', 'customer.name', 'customer.first_name', 'customer.phone', 'customer.status', 'customer.tags', 'conversation.status', 'loop.item', 'loop.number', 'vars.<name from an AI step>'],
  }));

  app.get('/workflows', { preHandler: read }, async (req) => app.tenantTx(req, async (c) => {
    const { rows } = await c.query(`SELECT ${WF},
      (SELECT count(*)::int FROM workflow_runs r WHERE r.workflow_id = workflows.id AND r.mode = 'live') AS "liveRuns",
      (SELECT count(*)::int FROM workflow_runs r WHERE r.workflow_id = workflows.id AND r.mode = 'live' AND r.status = 'failed') AS "failedRuns",
      (SELECT max(created_at) FROM workflow_runs r WHERE r.workflow_id = workflows.id AND r.mode = 'live') AS "lastRunAt"
      FROM workflows ORDER BY updated_at DESC LIMIT 200`);
    return { items: rows };
  }));

  app.post('/workflows', { preHandler: manage }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).default('') }).strict().parse(req.body);
    const wf = await app.tenantTx(req, async (c) => {
      const n = (await c.query(`SELECT count(*)::int AS n FROM workflows`)).rows[0].n as number;
      if (n >= 50) throw new AppError(409, 'workflow_limit', 'You can have up to 50 workflows.');
      const w = (await c.query(`INSERT INTO workflows (tenant_id, name, description, created_by, latest_version) VALUES ($1, $2, $3, $4, 1) RETURNING ${WF}`, [req.auth!.tenantId!, b.name, b.description, req.auth!.userId])).rows[0];
      await c.query(`INSERT INTO workflow_versions (tenant_id, workflow_id, version, graph, note, created_by) VALUES ($1, $2, 1, $3, 'Created', $4)`, [req.auth!.tenantId!, w.id, JSON.stringify(STARTER_GRAPH), req.auth!.userId]);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'workflow.created', 'workflow', w.id, { name: b.name });
      return w;
    });
    return reply.status(201).send(wf);
  });

  const full = async (c: any, id: string) => {
    const w = (await c.query(`SELECT ${WF} FROM workflows WHERE id = $1`, [id])).rows[0];
    if (!w) throw notFound('Workflow not found');
    const versions = (await c.query(`SELECT v.version, v.note, v.created_at AS "createdAt", u.full_name AS "createdByName", (v.id = $2) AS active FROM workflow_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.workflow_id = $1 ORDER BY v.version DESC LIMIT 100`, [id, w.activeVersionId])).rows;
    const latest = (await c.query(`SELECT graph FROM workflow_versions WHERE workflow_id = $1 AND version = $2`, [id, w.latestVersion])).rows[0];
    return { ...w, graph: latest.graph as Graph, versions };
  };

  app.get('/workflows/:id', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    return app.tenantTx(req, async (c) => {
      const w = await full(c, id);
      return { ...w, issues: await E.validate(c, w.graph, id) };
    });
  });

  app.patch('/workflows/:id', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(1000).optional() }).strict().parse(req.body);
    return app.tenantTx(req, async (c) => {
      const r = await c.query(`UPDATE workflows SET name = COALESCE($2, name), description = COALESCE($3, description) WHERE id = $1 RETURNING ${WF}`, [id, b.name ?? null, b.description ?? null]);
      if (!r.rows[0]) throw notFound('Workflow not found');
      return r.rows[0];
    });
  });

  /** Save = a new immutable version (only when something changed). baseVersion guards against two people overwriting each other. */
  app.put('/workflows/:id/graph', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ graph: graphSchema, baseVersion: z.number().int().min(1), note: z.string().trim().max(300).optional() }).strict().parse(req.body);
    return app.tenantTx(req, async (c) => {
      const w = (await c.query(`SELECT id, latest_version AS lv, status FROM workflows WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!w) throw notFound('Workflow not found');
      if (w.lv !== b.baseVersion) throw new AppError(409, 'version_conflict', `Someone saved version ${w.lv} while you were editing. Reload to see it.`, { latest: w.lv });
      const cur = (await c.query(`SELECT graph FROM workflow_versions WHERE workflow_id = $1 AND version = $2`, [id, w.lv])).rows[0];
      let version = w.lv as number;
      if (!sameGraph(cur.graph, b.graph)) {
        version = w.lv + 1;
        await c.query(`INSERT INTO workflow_versions (tenant_id, workflow_id, version, graph, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [req.auth!.tenantId!, id, version, JSON.stringify(b.graph), b.note ?? '', req.auth!.userId]);
        await c.query(`UPDATE workflows SET latest_version = $2 WHERE id = $1`, [id, version]);
        await audit(c, req.auth!.tenantId!, req.auth!.userId, 'workflow.saved', 'workflow', id, { version });
      }
      return { version, changed: version !== w.lv, issues: await E.validate(c, b.graph, id), liveVersionStillActive: w.status === 'active' };
    });
  });

  app.post('/workflows/:id/validate', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ graph: graphSchema }).strict().parse(req.body);
    return app.tenantTx(req, async (c) => ({ issues: await E.validate(c, b.graph, id) }));
  });

  app.get('/workflows/:id/versions/:v', { preHandler: read }, async (req) => {
    const p = z.object({ id: z.uuid(), v: z.coerce.number().int().min(1) }).parse(req.params);
    return app.tenantTx(req, async (c) => {
      const r = (await c.query(`SELECT version, graph, note, created_at AS "createdAt" FROM workflow_versions WHERE workflow_id = $1 AND version = $2`, [p.id, p.v])).rows[0];
      if (!r) throw notFound('Version not found');
      return r;
    });
  });

  app.post('/workflows/:id/versions/:v/restore', { preHandler: manage }, async (req) => {
    const p = z.object({ id: z.uuid(), v: z.coerce.number().int().min(1) }).parse(req.params);
    return app.tenantTx(req, async (c) => {
      const w = (await c.query(`SELECT latest_version AS lv FROM workflows WHERE id = $1 FOR UPDATE`, [p.id])).rows[0];
      if (!w) throw notFound('Workflow not found');
      const old = (await c.query(`SELECT graph FROM workflow_versions WHERE workflow_id = $1 AND version = $2`, [p.id, p.v])).rows[0];
      if (!old) throw notFound('Version not found');
      const version = w.lv + 1;
      await c.query(`INSERT INTO workflow_versions (tenant_id, workflow_id, version, graph, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [req.auth!.tenantId!, p.id, version, JSON.stringify(old.graph), `Restored from version ${p.v}`, req.auth!.userId]);
      await c.query(`UPDATE workflows SET latest_version = $2 WHERE id = $1`, [p.id, version]);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'workflow.restored', 'workflow', p.id, { from: p.v, version });
      return { version };
    });
  });

  /** Publish a version: from now on real customers' events start runs of THIS version. Validation errors block it. */
  app.post('/workflows/:id/activate', { preHandler: publish }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ version: z.number().int().min(1).optional() }).strict().parse(req.body ?? {});
    return app.tenantTx(req, async (c) => {
      const w = (await c.query(`SELECT id, latest_version AS lv FROM workflows WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!w) throw notFound('Workflow not found');
      const v = (await c.query(`SELECT id, version, graph FROM workflow_versions WHERE workflow_id = $1 AND version = $2`, [id, b.version ?? w.lv])).rows[0];
      if (!v) throw notFound('Version not found');
      const issues = await E.validate(c, v.graph, id);
      const errors = issues.filter((i) => i.level === 'error');
      if (errors.length) throw new AppError(422, 'workflow_invalid', `Cannot activate: ${errors[0]!.message}`, { issues });
      const trig = (v.graph as Graph).nodes.find((n) => n.type === 'trigger');
      await c.query(`UPDATE workflows SET status = 'active', active_version_id = $2 WHERE id = $1`, [id, v.id]);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'workflow.activated', 'workflow', id, { version: v.version, trigger: (trig?.data as any)?.kind });
      return { ...(await full(c, id)), issues };
    });
  });

  app.post('/workflows/:id/pause', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    return app.tenantTx(req, async (c) => {
      const r = await c.query(`UPDATE workflows SET status = 'paused' WHERE id = $1 AND status = 'active' RETURNING ${WF}`, [id]);
      if (!r.rows[0]) throw new AppError(409, 'not_active', 'Only an active workflow can be paused.');
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'workflow.paused', 'workflow', id, {});
      return r.rows[0];
    });
  });

  app.delete('/workflows/:id', { preHandler: publish }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await app.tenantTx(req, async (c) => {
      const used = (await c.query(`SELECT w.name FROM workflows w JOIN workflow_versions v ON v.workflow_id = w.id WHERE w.id <> $1 AND v.graph @> '{"nodes":[{"type":"subprocess"}]}' AND v.graph::text LIKE '%' || $1::text || '%' LIMIT 1`, [id])).rows[0];
      if (used) throw new AppError(409, 'workflow_in_use', `"${used.name}" uses this workflow as a Subprocess. Remove it there first.`);
      await c.query(`UPDATE workflow_runs SET status = 'cancelled', finished_at = now(), error = 'Workflow deleted' WHERE workflow_id = $1 AND status IN ('queued', 'waiting')`, [id]);
      await c.query(`UPDATE workflows SET status = 'paused', active_version_id = NULL WHERE id = $1`, [id]);
      const r = await c.query(`DELETE FROM workflows WHERE id = $1`, [id]);
      if (r.rowCount === 0) throw notFound('Workflow not found');
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'workflow.deleted', 'workflow', id, {});
    });
    return reply.status(204).send();
  });

  /** Dry run of a saved version with sample data. Customer-facing actions are described, never executed. */
  app.post('/workflows/:id/test', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({
      payload: z.object({
        platform: z.enum(['telegram', 'whatsapp', 'messenger', 'instagram', 'website']).default('telegram'),
        message: z.object({ text: z.string().max(2000) }).default({ text: '' }),
        customer: z.object({ name: z.string().max(120).default(''), first_name: z.string().max(120).optional(), phone: z.string().max(40).default(''), status: z.enum(['new', 'lead', 'customer', 'inactive']).default('new'), tags: z.string().max(300).default('') }).default({ name: '', phone: '', status: 'new', tags: '' }),
        items: z.array(z.string().max(200)).max(100).optional(),
      }).strict().default({ platform: 'telegram', message: { text: '' }, customer: { name: '', phone: '', status: 'new', tags: '' } }),
      version: z.number().int().min(1).optional(),
      taskOutcome: z.enum(['approved', 'rejected', 'timeout']).optional(),
    }).strict().parse(req.body ?? {});
    const payload = { ...b.payload, customer: { ...b.payload.customer, first_name: b.payload.customer.first_name ?? b.payload.customer.name.split(/\s+/)[0] ?? '' }, conversation: { status: 'open', handler: 'ai', platform: b.payload.platform } };
    const r = await E.test(req.auth!.tenantId!, req.auth!.userId, id, { payload, ...(b.version ? { version: b.version } : {}), ...(b.taskOutcome ? { taskOutcome: b.taskOutcome } : {}) });
    const { context, ...run } = r.run as any;
    return { run: { ...run, vars: context?.vars ?? {} }, steps: r.steps };
  });

  app.get('/workflows/:id/runs', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ mode: z.enum(['test', 'live']).optional(), status: z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    return app.tenantTx(req, async (c) => {
      if (!(await c.query('SELECT 1 FROM workflows WHERE id = $1', [id])).rows[0]) throw notFound('Workflow not found');
      const { rows } = await c.query(`SELECT ${RUN_COLS.replace(/\bcontext,/, '')} FROM workflow_runs WHERE workflow_id = $1 AND ($2::text IS NULL OR mode = $2) AND ($3::text IS NULL OR status = $3) AND parent_run_id IS NULL ORDER BY created_at DESC LIMIT $4`, [id, q.mode ?? null, q.status ?? null, q.limit]);
      return { items: rows.map(({ trigger, ...r }: any) => ({ ...r, triggerSummary: { platform: trigger.platform ?? null, text: trigger.message?.text ?? null } })) };
    });
  });

  app.get('/workflow-runs/:id', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = await E.detail(req.auth!.tenantId!, id);
    const { context, ...run } = d.run as any;
    return { ...d, run: { ...run, vars: context?.vars ?? {} } };
  });
  app.post('/workflow-runs/:id/cancel', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    await E.cancelRun(req.auth!.tenantId!, req.auth!.userId, id);
    return { ok: true };
  });

  app.get('/workflow-tasks', { preHandler: read }, async (req) => {
    const q = z.object({ status: z.enum(['open', 'completed', 'expired', 'cancelled']).default('open') }).parse(req.query);
    return app.tenantTx(req, async (c) => {
      const { rows } = await c.query(
        `SELECT t.id, t.title, t.instructions, t.assignee_role AS "assigneeRole", t.status, t.outcome, t.note, t.due_at AS "dueAt", t.created_at AS "createdAt", t.completed_at AS "completedAt", r.workflow_id AS "workflowId", w.name AS "workflowName", t.run_id AS "runId"
         FROM workflow_tasks t JOIN workflow_runs r ON r.id = t.run_id JOIN workflows w ON w.id = r.workflow_id WHERE t.status = $1 ORDER BY t.created_at DESC LIMIT 100`, [q.status]);
      return { items: rows };
    });
  });
  app.post('/workflow-tasks/:id/complete', { preHandler: tasks }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ outcome: z.enum(['approved', 'rejected']), note: z.string().trim().max(1000).optional() }).strict().parse(req.body);
    await E.completeTask(req.auth!.tenantId!, req.auth!.userId, req.auth!.role, id, b.outcome, b.note);
    return { ok: true };
  });

  /* ───────── notifications (each user only ever sees their own) ───────── */
  const auth = [app.authenticate];
  app.get('/notifications', { preHandler: auth }, async (req) => app.tenantTx(req, async (c) => {
    const { rows } = await c.query(`SELECT id, title, body, link, source, read_at AS "readAt", created_at AS "createdAt" FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40`, [req.auth!.userId]);
    const n = (await c.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [req.auth!.userId])).rows[0].n as number;
    return { items: rows, unread: n };
  }));
  app.post('/notifications/read', { preHandler: auth }, async (req) => {
    const b = z.object({ ids: z.array(z.uuid()).max(100).optional() }).strict().parse(req.body ?? {});
    return app.tenantTx(req, async (c) => {
      const r = await c.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`, [req.auth!.userId, b.ids ?? null]);
      return { updated: r.rowCount };
    });
  });
}
