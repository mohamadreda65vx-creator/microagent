import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, notFound } from '../../shared/errors.js';
import { configFingerprint, loadEmployee, loadRules, audit } from '../../agent/employee.js';
import { loadKnowledge } from '../../agent/knowledge.js';
import { runTurn, type TurnResult } from '../../agent/runtime.js';
import { buildSuite, MIN_SCENARIOS } from '../../agent/suite.js';
import { withTenant } from '../../db/tx.js';

const idParam = z.object({ id: z.uuid() });
const history = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(40);

const publicTrace = (r: TurnResult) => ({
  reply: r.reply,
  modelReply: r.modelReply,
  decisions: r.decisions,
  findings: r.findings,
  handoff: r.handoff,
  usedModel: r.usedModel,
  usage: r.usage,
  facts: r.facts,
  error: r.error ?? null,
});

export async function simulationRoutes(app: FastifyInstance): Promise<void> {
  const run = [app.authenticate, app.requirePermission('simulation:run')];
  const read = [app.authenticate, app.requirePermission('ai_employees:read')];

  /** Playground chat: one customer message, with the full trace (what the model wrote, what the backend decided, which facts were used). */
  app.post('/ai-employees/:id/simulate', { preHandler: run }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ message: z.string().trim().min(1).max(2000), history: history.default([]) }).parse(req.body);
    const tenantId = req.auth!.tenantId!;
    const exists = await app.tenantTx(req, (c) => loadEmployee(c, id));
    if (!exists) throw notFound('AI Employee not found');
    const r = await runTurn(app, { tenantId, employeeId: id, mode: 'simulation', history: b.history, message: b.message, actorUserId: req.auth!.userId });
    return publicTrace(r);
  });

  /** The test suite. Passing it for the CURRENT configuration is what allows the employee to go live. */
  app.post('/ai-employees/:id/simulate/suite', { preHandler: run }, async (req) => {
    const { id } = idParam.parse(req.params);
    const tenantId = req.auth!.tenantId!;
    const userId = req.auth!.userId;
    if (!app.ai.configured) throw new AppError(503, 'ai_not_configured', 'The AI provider is not configured on this server, so the employee cannot be tested.');
    const plan = await withTenant(app.pools.app, tenantId, async (c) => {
      const e = await loadEmployee(c, id);
      if (!e) throw notFound('AI Employee not found');
      return { e, rules: await loadRules(c, id), items: await loadKnowledge(c, e), fingerprint: await configFingerprint(c, e) };
    });
    const scenarios = buildSuite(plan.e, plan.rules, plan.items);
    const results: Array<Record<string, unknown>> = [];
    let ran = 0;
    let failed = 0;
    for (const s of scenarios) {
      if (s.skip) { results.push({ id: s.id, title: s.title, skipped: s.skip }); continue; }
      const r = await runTurn(app, { tenantId, employeeId: id, mode: 'simulation', history: [], message: s.message, persist: false, actorUserId: userId });
      // If the AI itself failed we cannot call this a pass.
      const checks = r.error ? [{ name: 'AI answered', ok: false, detail: r.error.message }] : s.evaluate(r);
      const ok = checks.every((x) => x.ok);
      ran++;
      if (!ok) failed++;
      results.push({ id: s.id, title: s.title, input: s.message, ok, checks, trace: publicTrace(r) });
    }
    const passed = failed === 0 && ran >= MIN_SCENARIOS;
    return withTenant(app.pools.app, tenantId, async (c) => {
      const e = await loadEmployee(c, id);
      if (!e) throw notFound('AI Employee not found');
      const stillSame = (await configFingerprint(c, e)) === plan.fingerprint; // the configuration may have been edited while the suite ran
      const { rows } = await c.query(`INSERT INTO simulation_runs (tenant_id, employee_id, kind, fingerprint, passed, results, created_by) VALUES ($1,$2,'suite',$3,$4,$5,$6) RETURNING id, created_at AS "createdAt"`, [tenantId, id, plan.fingerprint, passed, JSON.stringify(results), userId]);
      if (passed && stillSame) await c.query('UPDATE ai_employees SET tested_fingerprint = $2, tested_at = now() WHERE id = $1', [id, plan.fingerprint]);
      await audit(c, tenantId, userId, 'simulation.suite', 'ai_employee', id, { passed, ran, failed, skipped: results.length - ran, markedTested: passed && stillSame });
      return { runId: rows[0].id, passed, ran, failed, skipped: results.length - ran, minimum: MIN_SCENARIOS, markedTested: passed && stillSame, results, note: passed ? null : ran < MIN_SCENARIOS ? `At least ${MIN_SCENARIOS} scenarios must run. Add confirmed knowledge, tasks or rules so more scenarios apply.` : null };
    });
  });

  app.get('/ai-employees/:id/simulations', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await app.tenantTx(req, (c) => c.query(`SELECT id, kind, passed, fingerprint, created_at AS "createdAt", jsonb_array_length(results) AS scenarios FROM simulation_runs WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 30`, [id]));
    return { items: rows };
  });

  app.get('/ai-employees/:id/simulations/:runId', { preHandler: read }, async (req) => {
    const p = z.object({ id: z.uuid(), runId: z.uuid() }).parse(req.params);
    const { rows } = await app.tenantTx(req, (c) => c.query(`SELECT id, kind, passed, fingerprint, results, created_at AS "createdAt" FROM simulation_runs WHERE employee_id = $1 AND id = $2`, [p.id, p.runId]));
    if (!rows[0]) throw notFound('Run not found');
    return rows[0];
  });
}
