import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Client } from '../../db/pool.js';
import { classify } from '../../agent/classify.js';
import { CATEGORY_OF, effectKey, effectSchema, isEnforced, type Effect } from '../../agent/effects.js';
import { audit } from '../../agent/employee.js';
import { normKey } from '../../agent/text.js';
import { AppError, notFound } from '../../shared/errors.js';

const idParam = z.object({ id: z.uuid() });
const RULE_COLS = `r.id, r.employee_id AS "employeeId", e.name AS "employeeName", r.instruction, r.category, r.effect, r.status, r.version, r.created_at AS "createdAt", r.updated_at AS "updatedAt"`;

interface RuleRow { id: string; employee_id: string | null; instruction: string; category: string; effect: Effect; status: string; version: number }

async function snapshot(c: Client, tenantId: string, userId: string, r: { id: string; version: number; instruction: string; category: string; effect: unknown; status: string }, summary: string) {
  await c.query(`INSERT INTO teach_rule_versions (tenant_id, rule_id, version, instruction, category, effect, status, summary, changed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [tenantId, r.id, r.version, r.instruction, r.category, JSON.stringify(r.effect), r.status, summary, userId]);
}

/** A knowledge_fact rule owns one confirmed knowledge item. Keep them in sync (active → confirmed, disabled → retired). */
async function syncFact(c: Client, tenantId: string, userId: string, rule: { id: string; status: string; effect: Effect }) {
  if (rule.effect.type !== 'knowledge_fact') return;
  const e = rule.effect;
  const data: Record<string, unknown> = {};
  if (e.price !== undefined) data.price = e.price;
  if (e.currency) data.currency = e.currency;
  if (e.text) data.description = e.text;
  const status = rule.status === 'active' ? 'confirmed' : 'outdated';
  const ex = await c.query('SELECT id FROM knowledge_items WHERE rule_id = $1', [rule.id]);
  if (ex.rowCount) {
    await c.query(`UPDATE knowledge_items SET kind = $2, name = $3, norm_key = $4, data = $5, status = $6, source_date = now(), confirmed_by = $7, confirmed_at = now() WHERE rule_id = $1`, [rule.id, e.kind, e.name, normKey(e.name) || e.name.toLowerCase(), JSON.stringify(data), status, userId]);
  } else {
    await c.query(
      `INSERT INTO knowledge_items (tenant_id, rule_id, kind, name, norm_key, data, evidence, source_ref, source_date, origin, status, confirmed_by, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'taught by owner',now(),'owner',$8,$9,now())`,
      [tenantId, rule.id, e.kind, e.name, normKey(e.name) || e.name.toLowerCase(), JSON.stringify(data), e.name.slice(0, 500), status, userId],
    );
  }
}

export async function teachRoutes(app: FastifyInstance): Promise<void> {
  const read = [app.authenticate, app.requirePermission('rules:read')];
  const write = [app.authenticate, app.requirePermission('rules:write')];

  async function assertEmployee(c: Client, employeeId: string | null | undefined) {
    if (!employeeId) return;
    const r = await c.query('SELECT 1 FROM ai_employees WHERE id = $1', [employeeId]);
    if (!r.rowCount) throw notFound('AI Employee not found');
  }

  /** Step 1: understand the instruction. Nothing is saved. The owner sees exactly what will change and whether it is enforced. */
  app.post('/teach/preview', { preHandler: write }, async (req) => {
    const b = z.object({ instruction: z.string().trim().min(3).max(1000), employeeId: z.uuid().nullable().optional() }).parse(req.body);
    const tenantId = req.auth!.tenantId!;
    const existing = await app.tenantTx(req, async (c) => {
      await assertEmployee(c, b.employeeId);
      return (await c.query(`SELECT id, instruction, effect, employee_id FROM teach_rules WHERE status = 'active' AND (employee_id IS NOT DISTINCT FROM $1::uuid)`, [b.employeeId ?? null])).rows as Array<{ id: string; instruction: string; effect: Effect }>;
    });
    const result = await classify(b.instruction, app.ai, { tenantId });
    const proposals = result.proposals.map((p) => {
      const key = effectKey(p.effect);
      const same = existing.find((r) => effectKey(r.effect) === key);
      const singleton = ['dialect', 'language', 'tone'].includes(p.effect.type);
      return { ...p, duplicateOf: same && !singleton ? same.id : null, replaces: same && singleton ? { id: same.id, instruction: same.instruction } : null };
    });
    return { instruction: b.instruction, proposals, refused: result.refused ?? null, aiConfigured: app.ai.configured };
  });

  /** Step 2: save the effects the owner approved. The server re-validates every effect and derives the category itself. */
  app.post('/teach/rules', { preHandler: write }, async (req, reply) => {
    const b = z.object({ instruction: z.string().trim().min(3).max(1000), employeeId: z.uuid().nullable().default(null), effects: z.array(effectSchema).min(1).max(5) }).parse(req.body);
    const tenantId = req.auth!.tenantId!;
    const userId = req.auth!.userId;
    const created = await app.tenantTx(req, async (c) => {
      await assertEmployee(c, b.employeeId);
      const out: unknown[] = [];
      for (const effect of b.effects) {
        const key = effectKey(effect);
        const active = (await c.query(`SELECT id, effect FROM teach_rules WHERE status = 'active' AND employee_id IS NOT DISTINCT FROM $1::uuid`, [b.employeeId])).rows as Array<{ id: string; effect: Effect }>;
        const dup = active.find((r) => effectKey(r.effect) === key);
        const singleton = ['dialect', 'language', 'tone'].includes(effect.type);
        if (dup && !singleton) throw new AppError(409, 'rule_exists', 'This rule already exists', { ruleId: dup.id });
        if (dup && singleton) {
          // one dialect / language / tone at a time: the old one is disabled (and stays in its history), not deleted
          await c.query(`UPDATE teach_rules SET status = 'disabled', version = version + 1 WHERE id = $1`, [dup.id]);
          const old = (await c.query(`SELECT id, version, instruction, category, effect, status FROM teach_rules WHERE id = $1`, [dup.id])).rows[0];
          await snapshot(c, tenantId, userId, old, 'Replaced by a newer rule');
        }
        const category = CATEGORY_OF[effect.type];
        const { rows } = await c.query(`INSERT INTO teach_rules (tenant_id, employee_id, instruction, category, effect, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, version, instruction, category, effect, status`, [tenantId, b.employeeId, b.instruction, category, JSON.stringify(effect), userId]);
        await snapshot(c, tenantId, userId, rows[0], 'Created');
        await syncFact(c, tenantId, userId, { id: rows[0].id, status: 'active', effect });
        await audit(c, tenantId, userId, 'teach_rule.created', 'teach_rule', rows[0].id, { category, effect: effect.type, employeeId: b.employeeId, enforced: isEnforced(effect) });
        out.push({ ...rows[0], enforced: isEnforced(effect) });
      }
      return out;
    });
    return reply.status(201).send({ items: created });
  });

  app.get('/teach/rules', { preHandler: read }, async (req) => {
    const q = z.object({ employeeId: z.uuid().optional(), status: z.enum(['active', 'disabled']).optional() }).parse(req.query);
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(
        `SELECT ${RULE_COLS} FROM teach_rules r LEFT JOIN ai_employees e ON e.id = r.employee_id
         WHERE ($1::uuid IS NULL OR r.employee_id IS NULL OR r.employee_id = $1) AND ($2::text IS NULL OR r.status = $2) ORDER BY r.created_at DESC LIMIT 300`,
        [q.employeeId ?? null, q.status ?? null],
      ),
    );
    return { items: rows.map((r) => ({ ...r, enforced: isEnforced(r.effect as Effect) })) };
  });

  app.patch('/teach/rules/:id', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ instruction: z.string().trim().min(3).max(1000), effect: effectSchema, status: z.enum(['active', 'disabled']) }).partial().refine((v) => Object.keys(v).length > 0).parse(req.body);
    return app.tenantTx(req, async (c) => {
      const cur = (await c.query('SELECT id, employee_id, instruction, category, effect, status, version FROM teach_rules WHERE id = $1 FOR UPDATE', [id])).rows[0] as RuleRow | undefined;
      if (!cur) throw notFound('Rule not found');
      if (b.effect && (b.effect.type === 'knowledge_fact') !== (cur.effect.type === 'knowledge_fact')) throw new AppError(400, 'effect_type_locked', 'A knowledge rule cannot become a behaviour rule. Create a new rule instead.');
      const next = { id, instruction: b.instruction ?? cur.instruction, effect: b.effect ?? cur.effect, status: b.status ?? cur.status, version: cur.version + 1, category: CATEGORY_OF[(b.effect ?? cur.effect).type] };
      if (next.status === 'active') {
        const dup = (await c.query(`SELECT id, effect FROM teach_rules WHERE status = 'active' AND id <> $2 AND employee_id IS NOT DISTINCT FROM $1::uuid`, [cur.employee_id, id])).rows as Array<{ id: string; effect: Effect }>;
        if (dup.some((r) => effectKey(r.effect) === effectKey(next.effect))) throw new AppError(409, 'rule_exists', 'An active rule with the same effect already exists');
      }
      await c.query('UPDATE teach_rules SET instruction = $2, category = $3, effect = $4, status = $5, version = $6 WHERE id = $1', [id, next.instruction, next.category, JSON.stringify(next.effect), next.status, next.version]);
      await snapshot(c, req.auth!.tenantId!, req.auth!.userId, next, b.status && Object.keys(b).length === 1 ? (b.status === 'active' ? 'Enabled' : 'Disabled') : 'Edited');
      await syncFact(c, req.auth!.tenantId!, req.auth!.userId, next);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'teach_rule.updated', 'teach_rule', id, { version: next.version, status: next.status, fields: Object.keys(b) });
      return (await c.query(`SELECT ${RULE_COLS} FROM teach_rules r LEFT JOIN ai_employees e ON e.id = r.employee_id WHERE r.id = $1`, [id])).rows[0];
    });
  });

  app.get('/teach/rules/:id/versions', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(`SELECT v.version, v.instruction, v.effect, v.status, v.summary, v.created_at AS "createdAt", u.full_name AS "changedBy" FROM teach_rule_versions v LEFT JOIN users u ON u.id = v.changed_by WHERE v.rule_id = $1 ORDER BY v.version DESC`, [id]),
    );
    if (!rows.length) throw notFound('Rule not found');
    return { items: rows };
  });

  /** Rollback = re-apply an old version as a NEW version. History is never rewritten. */
  app.post('/teach/rules/:id/rollback', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { version } = z.object({ version: z.number().int().min(1) }).parse(req.body);
    return app.tenantTx(req, async (c) => {
      const cur = (await c.query('SELECT id, employee_id, version, effect FROM teach_rules WHERE id = $1 FOR UPDATE', [id])).rows[0] as { employee_id: string | null; version: number; effect: Effect } | undefined;
      if (!cur) throw notFound('Rule not found');
      const old = (await c.query('SELECT instruction, category, effect, status FROM teach_rule_versions WHERE rule_id = $1 AND version = $2', [id, version])).rows[0] as { instruction: string; category: string; effect: unknown; status: string } | undefined;
      if (!old) throw notFound('Version not found');
      const effect = effectSchema.safeParse(old.effect);
      if (!effect.success) throw new AppError(409, 'snapshot_invalid', 'That version can no longer be applied');
      if (old.status === 'active') {
        const dup = (await c.query(`SELECT effect FROM teach_rules WHERE status = 'active' AND id <> $2 AND employee_id IS NOT DISTINCT FROM $1::uuid`, [cur.employee_id, id])).rows as Array<{ effect: Effect }>;
        if (dup.some((r) => effectKey(r.effect) === effectKey(effect.data))) throw new AppError(409, 'rule_exists', 'An active rule with the same effect already exists');
      }
      const next = { id, version: cur.version + 1, instruction: old.instruction, category: CATEGORY_OF[effect.data.type], effect: effect.data, status: old.status };
      await c.query('UPDATE teach_rules SET instruction = $2, category = $3, effect = $4, status = $5, version = $6 WHERE id = $1', [id, next.instruction, next.category, JSON.stringify(next.effect), next.status, next.version]);
      await snapshot(c, req.auth!.tenantId!, req.auth!.userId, next, `Rolled back to version ${version}`);
      await syncFact(c, req.auth!.tenantId!, req.auth!.userId, next);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'teach_rule.rolled_back', 'teach_rule', id, { toVersion: version, newVersion: next.version });
      return { id, version: next.version, status: next.status };
    });
  });
}
