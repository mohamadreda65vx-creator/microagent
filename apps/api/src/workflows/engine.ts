/**
 * Workflow engine. Executes versioned graphs step by step; every step is written to the database
 * (workflow_steps), so a run can be inspected, resumed after a restart, or cancelled.
 *
 * Safety properties (enforced here, tested in test/workflows.test.ts):
 *  - TEST runs are dry: customer-facing and data-changing actions are described, never executed. Delays are skipped, tasks are auto-answered.
 *  - LIVE runs only start from an ACTIVE version, and the same trigger event can never start the same workflow twice (unique dedupe key).
 *  - Side effects are idempotent per step (unique message key, notification key, task key): a crash and retry cannot message a customer twice.
 *  - Hard limits: 200 steps per run, 100 loop iterations, 30-day delays, subprocess depth 3 with no cycles, 60 live runs per workflow per minute.
 *  - Messages respect opt-out, unreachable flags, channel status and the platform's reply window.
 *  - Workflow actions never fire triggers themselves, so workflows cannot start each other in an endless chain (only subprocess nodes call workflows, with a depth limit).
 */
import type { FastifyInstance } from 'fastify';
import { audit } from '../agent/employee.js';
import { runTurn } from '../agent/runtime.js';
import { extractJson } from '../ai/context.js';
import { WINDOW_MS } from '../campaigns/audience.js';
import type { Client } from '../db/pool.js';
import { withTenant } from '../db/tx.js';
import { AppError, notFound } from '../shared/errors.js';
import { CONFIG, evalCondition, graphSchema, nextNode, render, toMs, validateGraph, getPath, type Ctx, type Graph, type GNode, type Issue } from './graph.js';

export const MAX_STEPS = 200;
export const MAX_LOOP = 100;
export const MAX_LIVE_PER_MINUTE = 60;
const RANK: Record<string, number> = { viewer: 0, manager: 1, admin: 2, owner: 3 };

export interface RunRow {
  id: string; workflowId: string; versionId: string; mode: 'test' | 'live'; status: string; triggerKind: string; trigger: Record<string, any>; context: Ctx;
  currentNode: string | null; waitKind: string | null; resumeAt: string | null; parentRunId: string | null; parentNodeId: string | null; depth: number; stepCount: number;
  error: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string;
}
export const RUN_COLS = `id, workflow_id AS "workflowId", version_id AS "versionId", mode, status, trigger_kind AS "triggerKind", trigger, context, current_node AS "currentNode", wait_kind AS "waitKind",
  resume_at AS "resumeAt", parent_run_id AS "parentRunId", parent_node_id AS "parentNodeId", depth, step_count AS "stepCount", error, started_at AS "startedAt", finished_at AS "finishedAt", created_at AS "createdAt"`;

interface Out { handle: string | null; output?: Record<string, unknown>; input?: Record<string, unknown>; vars?: Record<string, unknown>; skipped?: boolean; error?: string; wait?: { kind: 'delay' | 'task' | 'child'; resumeAt?: Date | null; next?: string | null }; childToKick?: string }
const clip = (o: unknown, n = 4000): any => { const s = JSON.stringify(o ?? {}); return s.length > n ? { truncated: true, preview: s.slice(0, n) } : o; };
const errText = (e: unknown) => (e instanceof AppError ? e.message : e instanceof Error ? e.message : 'unknown error').slice(0, 500);

export class WorkflowEngine {
  private readonly busy = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly app: FastifyInstance) {}
  private tx<T>(tenantId: string, fn: (c: Client) => Promise<T>) { return withTenant(this.app.pools.app, tenantId, fn); }
  private track(p: Promise<unknown>) { const q = p.catch((e) => { this.app.log.error({ err: e }, 'workflow error'); }).finally(() => this.pending.delete(q)); this.pending.add(q); }
  async idle(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending]); }

  /* ───────────── validation ───────────── */
  async validate(c: Client, graph: Graph, selfId?: string): Promise<Issue[]> {
    const employees = new Map((await c.query(`SELECT id, status FROM ai_employees`)).rows.map((r) => [r.id as string, r.status as string]));
    const workflows = new Map((await c.query(`SELECT id, (status = 'active') AS active FROM workflows`)).rows.map((r) => [r.id as string, { active: r.active as boolean }]));
    const issues = validateGraph(graph, { employees, workflows, ...(selfId ? { selfId } : {}) });
    // Subprocess chains: no cycles through other workflows, depth ≤ 3.
    if (selfId) {
      const edges = await this.callGraph(c, graph, selfId);
      const cyc = this.findSubCycle(edges, selfId);
      if (cyc) issues.push({ level: 'error', code: 'subprocess_cycle', message: 'Workflows call each other in a circle through Subprocess nodes.' });
      else if (this.subDepth(edges, selfId) > 3) issues.push({ level: 'error', code: 'subprocess_depth', message: 'Subprocess chains can be at most 3 workflows deep.' });
    }
    return issues;
  }
  private async callGraph(c: Client, self: Graph, selfId: string): Promise<Map<string, string[]>> {
    const m = new Map<string, string[]>();
    const targets = (g: Graph) => g.nodes.filter((n) => n.type === 'subprocess').map((n) => (n.data as any).workflowId as string).filter(Boolean);
    m.set(selfId, targets(self));
    const todo = [...m.get(selfId)!];
    while (todo.length) {
      const id = todo.pop()!; if (m.has(id)) continue;
      const r = await c.query(`SELECT v.graph FROM workflows w JOIN workflow_versions v ON v.id = COALESCE(w.active_version_id, (SELECT id FROM workflow_versions x WHERE x.workflow_id = w.id ORDER BY version DESC LIMIT 1)) WHERE w.id = $1`, [id]);
      const g = r.rows[0]?.graph as Graph | undefined; const t = g ? targets(g) : [];
      m.set(id, t); todo.push(...t);
    }
    return m;
  }
  private findSubCycle(m: Map<string, string[]>, start: string): boolean {
    const visit = (id: string, path: Set<string>): boolean => { if (path.has(id)) return true; path.add(id); for (const t of m.get(id) ?? []) if (visit(t, new Set(path))) return true; return false; };
    return visit(start, new Set());
  }
  private subDepth(m: Map<string, string[]>, id: string): number { return Math.max(0, ...(m.get(id) ?? []).map((t) => 1 + this.subDepth(m, t))); }

  /* ───────────── starting runs ───────────── */
  /** Called by the channel / customer code when something happens. Never throws into the caller. */
  async emit(tenantId: string, kind: 'message_received' | 'conversation_handoff' | 'customer_status_changed', p: { platform: string; conversationId?: string | null; contactId?: string | null; channelId?: string | null; text?: string; toStatus?: string; fromStatus?: string; reason?: string; dedupe: string }): Promise<number> {
    let started = 0;
    const toKick: string[] = [];
    await this.tx(tenantId, async (c) => {
      const wfs = (await c.query(`SELECT w.id, w.active_version_id AS vid, v.graph FROM workflows w JOIN workflow_versions v ON v.id = w.active_version_id WHERE w.status = 'active'`)).rows;
      for (const w of wfs) {
        const t = (w.graph as Graph).nodes.find((n) => n.type === 'trigger');
        const d = (t?.data ?? {}) as Record<string, any>;
        if (!t || d.kind !== kind) continue;
        if (d.platforms?.length && !d.platforms.includes(p.platform)) continue;
        if (d.containsAny?.length && !d.containsAny.some((k: string) => (p.text ?? '').toLowerCase().includes(k.toLowerCase()))) continue;
        if (d.toStatus && d.toStatus !== p.toStatus) continue;
        const recent = (await c.query(`SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_id = $1 AND mode = 'live' AND depth = 0 AND created_at > now() - interval '1 minute'`, [w.id])).rows[0].n as number;
        if (recent >= MAX_LIVE_PER_MINUTE) { await c.query(`INSERT INTO system_errors (tenant_id, source, code, message) VALUES ($1, 'workflows', 'rate_limited', $2)`, [tenantId, `Workflow ${w.id} skipped a run: more than ${MAX_LIVE_PER_MINUTE} per minute`]); continue; }
        const trigger = { kind, platform: p.platform, conversationId: p.conversationId ?? null, contactId: p.contactId ?? null, channelId: p.channelId ?? null, message: { text: p.text ?? '' }, status: { from: p.fromStatus ?? null, to: p.toStatus ?? null }, handoff: { reason: p.reason ?? '' } };
        const r = await c.query(
          `INSERT INTO workflow_runs (tenant_id, workflow_id, version_id, mode, status, trigger_kind, trigger, context, dedupe_key) VALUES ($1, $2, $3, 'live', 'queued', $4, $5, $6, $7)
           ON CONFLICT (workflow_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
          [tenantId, w.id, w.vid, kind, JSON.stringify(trigger), JSON.stringify({ trigger, vars: {}, steps: {}, visits: {}, loops: {}, children: {} }), p.dedupe],
        );
        if (r.rows[0]) { started++; toKick.push(r.rows[0].id); }
      }
    });
    for (const id of toKick) this.kick(tenantId, id);
    return started;
  }
  /** Fire-and-forget version of emit() for callers that must not wait or fail (the work is tracked, so shutdown and tests can wait for it). */
  fire(tenantId: string, kind: Parameters<WorkflowEngine['emit']>[1], p: Parameters<WorkflowEngine['emit']>[2]): void { this.track(this.emit(tenantId, kind, p)); }
  kick(tenantId: string, runId: string): void { this.track(this.execute(tenantId, runId)); }

  /** Test run: dry, synchronous, uses the chosen version (default: the latest draft). */
  async test(tenantId: string, userId: string, workflowId: string, o: { payload: Record<string, any>; version?: number; taskOutcome?: 'approved' | 'rejected' | 'timeout'; graph?: Graph }): Promise<{ run: RunRow; steps: any[] }> {
    const created = await this.tx(tenantId, async (c) => {
      const w = (await c.query(`SELECT id, latest_version AS lv FROM workflows WHERE id = $1`, [workflowId])).rows[0];
      if (!w) throw notFound('Workflow not found');
      const v = (await c.query(`SELECT id, graph FROM workflow_versions WHERE workflow_id = $1 AND version = $2`, [workflowId, o.version ?? w.lv])).rows[0];
      if (!v) throw notFound('Version not found');
      const issues = await this.validate(c, v.graph as Graph, workflowId);
      const errors = issues.filter((i) => i.level === 'error');
      if (errors.length) throw new AppError(422, 'workflow_invalid', `Fix ${errors.length} problem(s) before testing: ${errors[0]!.message}`, { issues });
      const trigger = { kind: 'manual', ...o.payload };
      const ctx: Ctx = { trigger, customer: o.payload.customer ?? {}, conversation: o.payload.conversation ?? {}, vars: {}, steps: {}, visits: {}, loops: {}, children: {}, testOptions: { taskOutcome: o.taskOutcome ?? 'approved' } };
      const r = await c.query(`INSERT INTO workflow_runs (tenant_id, workflow_id, version_id, mode, status, trigger_kind, trigger, context, created_by) VALUES ($1, $2, $3, 'test', 'queued', 'manual', $4, $5, $6) RETURNING id`, [tenantId, workflowId, v.id, JSON.stringify(trigger), JSON.stringify(ctx), userId]);
      await audit(c, tenantId, userId, 'workflow.test_run', 'workflow', workflowId, { version: o.version ?? w.lv });
      return r.rows[0].id as string;
    });
    await this.execute(tenantId, created);
    return this.detail(tenantId, created);
  }

  async detail(tenantId: string, runId: string): Promise<{ run: RunRow; steps: any[]; tasks: any[] }> {
    return this.tx(tenantId, async (c) => {
      const run = (await c.query(`SELECT ${RUN_COLS} FROM workflow_runs WHERE id = $1`, [runId])).rows[0];
      if (!run) throw notFound('Run not found');
      const steps = (await c.query(`SELECT seq, node_id AS "nodeId", node_type AS "nodeType", status, dry_run AS "dryRun", input, output, error, started_at AS "startedAt", finished_at AS "finishedAt" FROM workflow_steps WHERE run_id = $1 ORDER BY seq`, [runId])).rows;
      const tasks = (await c.query(`SELECT id, node_id AS "nodeId", title, status, outcome, note, due_at AS "dueAt", completed_at AS "completedAt" FROM workflow_tasks WHERE run_id = $1 ORDER BY created_at`, [runId])).rows;
      return { run, steps, tasks };
    });
  }

  /* ───────────── the executor ───────────── */
  async execute(tenantId: string, runId: string): Promise<void> {
    if (this.busy.has(runId)) return;
    this.busy.add(runId);
    try {
      const claimed = await this.tx(tenantId, async (c) => {
        const r = (await c.query(`SELECT ${RUN_COLS}, (SELECT graph FROM workflow_versions v WHERE v.id = workflow_runs.version_id) AS graph, locked_at AS "lockedAt" FROM workflow_runs WHERE id = $1 FOR UPDATE`, [runId])).rows[0];
        if (!r) return null;
        const stale = r.status === 'running' && r.lockedAt && Date.now() - new Date(r.lockedAt).getTime() > 5 * 60_000;
        const due = r.status === 'waiting' && r.resumeAt && new Date(r.resumeAt).getTime() <= Date.now();
        const resumable = r.status === 'queued' || stale || due;
        if (!resumable) return null;
        await c.query(`UPDATE workflow_runs SET status = 'running', locked_at = now(), started_at = COALESCE(started_at, now()), wait_kind = NULL, resume_at = NULL WHERE id = $1`, [runId]);
        return { run: r as RunRow, graph: r.graph as Graph, resuming: ['task', 'child'].includes(r.waitKind ?? '') || (r.status === 'running' && stale && !!r.currentNode) };
      });
      if (!claimed) return;
      await this.loop(tenantId, claimed.run, claimed.graph, claimed.resuming);
    } finally { this.busy.delete(runId); }
  }

  private async loop(tenantId: string, run: RunRow, graph: Graph, resuming: boolean): Promise<void> {
    const dry = run.mode === 'test';
    const ctx = (run.context ?? {}) as Ctx & { visits: Record<string, number>; vars: Record<string, unknown>; steps: Record<string, unknown>; loops: Record<string, any>; children: Record<string, string> };
    ctx.visits ??= {}; ctx.vars ??= {}; ctx.steps ??= {}; ctx.loops ??= {}; ctx.children ??= {};
    let node = run.currentNode ?? graph.nodes.find((n) => n.type === 'trigger')?.id ?? null;
    let steps = run.stepCount;
    const finish = async (status: 'completed' | 'failed', error?: string) => {
      await this.tx(tenantId, async (c) => { await c.query(`UPDATE workflow_runs SET status = $2, error = $3, finished_at = now(), locked_at = NULL, context = $4, current_node = NULL WHERE id = $1 AND status = 'running'`, [run.id, status, error ?? null, JSON.stringify(clip(ctx, 60000))]); });
      await this.onFinished(tenantId, run);
    };
    while (node) {
      if (steps >= MAX_STEPS) return finish('failed', `Stopped: more than ${MAX_STEPS} steps in one run (is there an endless loop?).`);
      const n = graph.nodes.find((x) => x.id === node);
      if (!n) return finish('failed', `Node ${node} no longer exists in this version.`);
      if (!dry) await this.refreshEntities(tenantId, ctx);
      if (!(resuming && steps === run.stepCount)) ctx.visits[n.id] = (ctx.visits[n.id] ?? 0) + 1;
      const key = `${run.id}:${n.id}:${ctx.visits[n.id]}`;
      const started = new Date();
      let out: Out;
      try { out = await this.runNode(tenantId, run, graph, n, ctx, dry, key); } catch (e) { out = { handle: null, error: errText(e) }; }
      steps++;
      const next = out.error || out.wait ? null : out.handle ? nextNode(graph, n.id, out.handle) : null;
      if (out.vars) Object.assign(ctx.vars, out.vars);
      ctx.steps[n.id] = clip(out.output ?? {}, 2000);
      const status = out.error ? 'error' : out.wait ? 'waiting' : out.skipped ? 'skipped' : 'ok';
      const stillRunning = await this.tx(tenantId, async (c) => {
        const upd = await c.query(
          `UPDATE workflow_runs SET step_count = $2, context = $3, current_node = $4, locked_at = now() WHERE id = $1 AND status = 'running'`,
          [run.id, steps, JSON.stringify(clip(ctx, 60000)), out.wait?.kind === 'delay' ? (out.wait.next ?? null) : out.wait ? n.id : next],
        );
        if (upd.rowCount === 0) return false;
        await c.query(
          `INSERT INTO workflow_steps (tenant_id, run_id, seq, node_id, node_type, status, dry_run, input, output, error, started_at, finished_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
          [tenantId, run.id, steps, n.id, n.type, status, dry, JSON.stringify(clip(out.input ?? {})), JSON.stringify(clip({ ...(out.output ?? {}), ...(out.handle ? { handle: out.handle } : {}) })), out.error ?? null, started],
        );
        return true;
      });
      if (!stillRunning) return; // cancelled while running
      if (out.error) return finish('failed', `${n.type} step failed: ${out.error}`);
      if (out.wait) {
        if (out.wait.kind === 'delay' && !out.wait.next) return finish('completed');
        await this.tx(tenantId, (c) => c.query(`UPDATE workflow_runs SET status = 'waiting', wait_kind = $2, resume_at = $3, locked_at = NULL WHERE id = $1 AND status = 'running'`, [run.id, out.wait!.kind, out.wait!.resumeAt ?? null]));
        if (out.childToKick) this.kick(tenantId, out.childToKick);
        return;
      }
      node = next;
      resuming = false;
    }
    return finish('completed');
  }

  private async onFinished(tenantId: string, run: RunRow): Promise<void> {
    if (!run.parentRunId) return;
    if (run.mode === 'test') return; // test parents wait inline
    const woke = await this.tx(tenantId, (c) => c.query(`UPDATE workflow_runs SET status = 'queued' WHERE id = $1 AND status = 'waiting' AND wait_kind = 'child' RETURNING id`, [run.parentRunId]));
    if (woke.rows[0]) this.kick(tenantId, run.parentRunId);
  }

  /** Customer / conversation data for templates and conditions (live runs read the real, current records). */
  private async refreshEntities(tenantId: string, ctx: Ctx): Promise<void> {
    const t = ctx.trigger as Record<string, any> | undefined;
    if (!t?.conversationId) return;
    const r = await this.tx(tenantId, (c) => c.query(
      `SELECT ct.name, ct.phone, ct.email, ct.status, ct.tags, ct.consent_status AS consent, cv.platform, cv.status AS "convStatus", cv.handler FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = $1`, [t.conversationId]));
    const x = r.rows[0];
    if (!x) return;
    ctx.customer = { name: x.name ?? '', first_name: String(x.name ?? '').split(/\s+/)[0] ?? '', phone: x.phone ?? '', email: x.email ?? '', status: x.status, tags: (x.tags as string[]).join(','), consent: x.consent, platform: x.platform };
    ctx.conversation = { status: x.convStatus, handler: x.handler, platform: x.platform };
  }

  /* ───────────── nodes ───────────── */
  private async runNode(tenantId: string, run: RunRow, graph: Graph, n: GNode, ctx: Ctx, dry: boolean, key: string): Promise<Out> {
    const parsed = CONFIG[n.type].safeParse(n.data);
    if (!parsed.success) return { handle: null, error: `invalid settings (${parsed.error.issues[0]?.message})` };
    const d = parsed.data as Record<string, any>;
    const trig = (ctx.trigger ?? {}) as Record<string, any>;
    switch (n.type) {
      case 'trigger': return { handle: 'out', output: { kind: d.kind, platform: trig.platform ?? null, text: trig.message?.text ?? null } };

      case 'condition': {
        const r = evalCondition(d as any, ctx);
        return { handle: r.result ? 'true' : 'false', input: { match: d.match }, output: { result: r.result, rules: r.details } };
      }

      case 'delay': {
        const ms = toMs(d.amount, d.unit);
        const next = nextNode(graph, n.id, 'out');
        if (dry) return { handle: 'out', skipped: true, output: { note: `Test run: skipped a wait of ${d.amount} ${d.unit}. A live run would pause here.` } };
        return { handle: null, output: { waitingFor: `${d.amount} ${d.unit}` }, wait: { kind: 'delay', resumeAt: new Date(Date.now() + ms), next } };
      }

      case 'ai_agent': return this.aiNode(tenantId, d, ctx);

      case 'action': return this.actionNode(tenantId, run, d, ctx, dry, key);

      case 'notification': {
        const title = render(d.title, ctx).text, body = render(d.body ?? '', ctx).text;
        const users = await this.tx(tenantId, async (c) => (await c.query(`SELECT id FROM users WHERE status = 'active' AND role = ANY($1::text[]) ORDER BY created_at LIMIT 50`, [d.roles])).rows.map((r) => r.id as string));
        if (dry) return { handle: 'out', input: { title, body }, output: { dryRun: true, wouldNotify: users.length, roles: d.roles } };
        await this.tx(tenantId, async (c) => {
          for (const u of users) await c.query(`INSERT INTO notifications (tenant_id, user_id, title, body, link, source, run_id) SELECT $1, $2, $3, $4, $5, $6, $7 WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = $2 AND source = $6)`,
            [tenantId, u, title, body, trig.conversationId ? `/app/inbox/${trig.platform === 'website' ? 'website-chat' : trig.platform}?c=${trig.conversationId}` : null, `workflow:${key}`, run.id]);
        });
        return { handle: 'out', input: { title, body }, output: { notified: users.length } };
      }

      case 'human_task': {
        const title = render(d.title, ctx).text;
        if (dry) {
          const outcome = ((ctx.testOptions as any)?.taskOutcome ?? 'approved') as string;
          return { handle: outcome, skipped: true, input: { title, assigneeRole: d.assigneeRole }, output: { note: `Test run: the task was answered automatically as "${outcome}".` } };
        }
        const taskKey = `${n.id}#${(ctx.visits as any)[n.id]}`;
        const t = await this.tx(tenantId, async (c) => {
          const ex = (await c.query(`SELECT id, status, outcome, due_at AS "dueAt" FROM workflow_tasks WHERE run_id = $1 AND node_id = $2`, [run.id, taskKey])).rows[0];
          if (ex) {
            if (ex.status === 'open' && ex.dueAt && new Date(ex.dueAt).getTime() <= Date.now()) { await c.query(`UPDATE workflow_tasks SET status = 'expired' WHERE id = $1`, [ex.id]); return { ...ex, status: 'expired', fresh: false }; }
            return { ...ex, fresh: false };
          }
          const due = d.dueHours ? new Date(Date.now() + d.dueHours * 3600_000) : null;
          const ins = (await c.query(`INSERT INTO workflow_tasks (tenant_id, run_id, node_id, title, instructions, assignee_role, due_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, status, outcome, due_at AS "dueAt"`, [tenantId, run.id, taskKey, title, render(d.instructions ?? '', ctx).text, d.assigneeRole, due])).rows[0];
          const roles = d.assigneeRole === 'manager' ? ['manager', 'admin', 'owner'] : d.assigneeRole === 'admin' ? ['admin', 'owner'] : ['owner'];
          const us = (await c.query(`SELECT id FROM users WHERE status = 'active' AND role = ANY($1::text[]) LIMIT 50`, [roles])).rows;
          for (const u of us) await c.query(`INSERT INTO notifications (tenant_id, user_id, title, body, link, source, run_id) VALUES ($1, $2, $3, $4, '/app/workflows/tasks', $5, $6)`, [tenantId, u.id, `Task: ${title}`, 'A workflow is waiting for your decision.', `workflow-task:${ins.id}`, run.id]);
          return { ...ins, fresh: true };
        });
        if (t.status === 'open') return { handle: null, input: { title }, output: { taskId: t.id, waitingFor: `a ${d.assigneeRole} or higher` }, wait: { kind: 'task', resumeAt: t.dueAt ? new Date(t.dueAt) : null } };
        if (t.status === 'expired') return { handle: 'timeout', output: { taskId: t.id, outcome: 'timeout' } };
        if (t.status === 'cancelled') return { handle: null, error: 'The task was cancelled.' };
        return { handle: t.outcome as string, output: { taskId: t.id, outcome: t.outcome }, vars: { [`task_${n.id}`]: t.outcome } };
      }

      case 'loop': {
        const loops = ctx.loops as Record<string, any>;
        let st = loops[n.id];
        if (!st) {
          let items: unknown[] | null = null;
          let total: number;
          if (d.source === 'count') total = d.count ?? 1;
          else {
            const v = getPath(ctx, d.listVar);
            const arr = typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : v;
            if (!Array.isArray(arr)) return { handle: null, error: `"${d.listVar}" is not a list in this run's data.` };
            items = arr; total = arr.length;
          }
          if (total > MAX_LOOP) return { handle: null, error: `The loop would run ${total} times; the limit is ${MAX_LOOP}.` };
          st = loops[n.id] = { i: 0, total, items };
        }
        if (st.i < st.total) {
          ctx.loop = { index: st.i, number: st.i + 1, total: st.total, item: st.items ? st.items[st.i] : st.i + 1 };
          st.i++;
          return { handle: 'body', output: { iteration: st.i, of: st.total } };
        }
        delete loops[n.id]; delete ctx.loop;
        return { handle: 'done', output: { finished: st.total } };
      }

      case 'subprocess': return this.subprocess(tenantId, run, d.workflowId as string, n, ctx, dry);
    }
  }

  private async aiNode(tenantId: string, d: Record<string, any>, ctx: Ctx): Promise<Out> {
    const { text: prompt, missing } = render(d.prompt, ctx);
    const emp = await this.tx(tenantId, async (c) => (await c.query(`SELECT status FROM ai_employees WHERE id = $1`, [d.employeeId])).rows[0]);
    if (!emp) return { handle: null, error: 'The AI employee no longer exists.' };
    if (emp.status !== 'active') return { handle: null, error: 'The AI employee is not active.' };
    if (!this.app.ai.configured) return { handle: null, error: 'The AI is not configured on this server.' };
    if (d.mode === 'choice') {
      const choices = d.choices as string[];
      const res = await this.app.ai.complete({ tenantId, employeeId: d.employeeId, purpose: 'workflow' }, {
        model: this.app.ai.defaultModel,
        messages: [{ role: 'system', content: `Pick exactly ONE option for the request. Options: ${choices.map((c) => `"${c}"`).join(', ')}. Answer only with JSON: {"choice": "<one option>"}. If none fits, use {"choice": "unknown"}.` }, { role: 'user', content: prompt.slice(0, 3000) }],
        temperature: 0, maxTokens: 60, json: true,
      });
      let c = 'unknown';
      try { const j = extractJson(res.text) as { choice?: unknown }; const m = choices.find((x) => x.toLowerCase() === String(j?.choice ?? '').trim().toLowerCase()); if (m) c = m; } catch { /* stays unknown */ }
      return { handle: 'out', input: { prompt, missing }, output: { choice: c, matched: c !== 'unknown' }, vars: { [d.outputVar]: c } };
    }
    const r = await runTurn(this.app, { tenantId, employeeId: d.employeeId, mode: 'simulation', history: [], message: prompt.slice(0, 3000), persist: false });
    if (r.error || !r.usedModel) return { handle: null, error: `AI unavailable (${r.error?.code ?? 'no answer'})` };
    return { handle: 'out', input: { prompt, missing }, output: { reply: r.reply, guardrails: r.findings.map((f) => f.code), handoffSuggested: !!r.handoff }, vars: { [d.outputVar]: r.reply } };
  }

  private async actionNode(tenantId: string, run: RunRow, d: Record<string, any>, ctx: Ctx, dry: boolean, key: string): Promise<Out> {
    const t = (ctx.trigger ?? {}) as Record<string, any>;
    if (!dry && (!t.conversationId || !t.contactId)) return { handle: null, error: 'This action needs a customer. Use a trigger that comes from a conversation (message received, hand-off, status change).' };
    const input: Record<string, unknown> = { kind: d.kind };
    let text = '';
    if (d.kind === 'send_message') {
      const r = render(d.text, ctx);
      if (r.missing.length) return { handle: null, input: { template: d.text }, error: `Cannot send: no value for ${r.missing.map((m) => `{{${m}}}`).join(', ')}. Messages are never sent with blanks or invented data.` };
      text = r.text; input.text = text;
    }
    if (d.kind === 'add_note') { text = render(d.note, ctx).text; input.note = text; }
    if (d.tag) input.tag = String(d.tag).trim().toLowerCase();
    if (d.status) input.status = d.status;
    if (d.reason) { input.reason = render(d.reason, ctx).text; }
    if (dry) return { handle: 'out', input, output: { dryRun: true, wouldDo: describe(d.kind, input), note: 'Test run: nothing was changed or sent.' } };

    switch (d.kind) {
      case 'send_message': {
        const chk = await this.tx(tenantId, async (c) => (await c.query(
          `SELECT cv.platform, cv.last_inbound_at AS "lastInbound", ch.status AS "channelStatus", ct.consent_status AS consent, ct.unreachable_at AS unreachable FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = $1`, [t.conversationId])).rows[0]);
        if (!chk) return { handle: null, input, error: 'The conversation no longer exists.' };
        if (chk.channelStatus !== 'connected') return { handle: null, input, error: `The channel is ${chk.channelStatus}, so nothing was sent.` };
        if (chk.consent === 'opted_out') return { handle: null, input, error: 'The customer opted out of messages. Nothing was sent.' };
        if (chk.unreachable) return { handle: null, input, error: 'The platform reports this customer as unreachable. Nothing was sent.' };
        if (['messenger', 'instagram', 'whatsapp'].includes(chk.platform) && (!chk.lastInbound || Date.now() - new Date(chk.lastInbound).getTime() > WINDOW_MS))
          return { handle: null, input, error: `Outside ${chk.platform}'s reply window (the customer's last message is older than 24 hours). Nothing was sent.` };
        try {
          const res = await this.app.channels.sendMessage(tenantId, { conversationId: t.conversationId, text, senderType: 'system', meta: { workflow: { runId: run.id }, workflowStepKey: key } });
          if (res.status === 'failed') return { handle: null, input, output: { messageId: res.id }, error: `The channel refused the message (${res.error ?? 'unknown'}).` };
          return { handle: 'out', input, output: { messageId: res.id, status: res.status } };
        } catch (e) {
          if ((e as { code?: string }).code === '23505') return { handle: 'out', input, output: { alreadySent: true } };
          throw e;
        }
      }
      case 'add_tag': case 'remove_tag': {
        const tag = String(input.tag);
        const r = await this.tx(tenantId, async (c) => {
          const ct = (await c.query(`SELECT id, channel_id, tags FROM contacts WHERE id = $1 FOR UPDATE`, [t.contactId])).rows[0];
          if (!ct) return { err: 'The customer no longer exists.' };
          const tags = ct.tags as string[];
          const has = tags.includes(tag);
          if (d.kind === 'add_tag') {
            if (has) return { changed: false };
            if (tags.length >= 30) return { err: 'This customer already has 30 tags.' };
            await c.query(`UPDATE contacts SET tags = array_append(tags, $2) WHERE id = $1`, [ct.id, tag]);
          } else {
            if (!has) return { changed: false };
            await c.query(`UPDATE contacts SET tags = array_remove(tags, $2) WHERE id = $1`, [ct.id, tag]);
          }
          await c.query(`INSERT INTO customer_events (tenant_id, channel_id, contact_id, kind, detail) VALUES ($1, $2, $3, $4, $5)`, [tenantId, ct.channel_id, ct.id, d.kind === 'add_tag' ? 'tag_added' : 'tag_removed', JSON.stringify({ tag, source: 'workflow' })]);
          return { changed: true };
        });
        if ('err' in r) return { handle: null, input, error: r.err };
        return { handle: 'out', input, output: { tag, changed: r.changed } };
      }
      case 'set_customer_status': {
        const r = await this.tx(tenantId, async (c) => {
          const ct = (await c.query(`SELECT id, channel_id, status FROM contacts WHERE id = $1 FOR UPDATE`, [t.contactId])).rows[0];
          if (!ct) return null;
          if (ct.status !== d.status) {
            await c.query(`UPDATE contacts SET status = $2 WHERE id = $1`, [ct.id, d.status]);
            await c.query(`INSERT INTO customer_events (tenant_id, channel_id, contact_id, kind, detail) VALUES ($1, $2, $3, 'status_changed', $4)`, [tenantId, ct.channel_id, ct.id, JSON.stringify({ from: ct.status, to: d.status, source: 'workflow' })]);
          }
          return { from: ct.status as string, changed: ct.status !== d.status };
        });
        if (!r) return { handle: null, input, error: 'The customer no longer exists.' };
        return { handle: 'out', input, output: { from: r.from, to: d.status, changed: r.changed } };
      }
      case 'set_conversation_status': {
        await this.tx(tenantId, (c) => c.query(`UPDATE conversations SET status = $2 WHERE id = $1`, [t.conversationId, d.status]));
        return { handle: 'out', input, output: { status: d.status } };
      }
      case 'handoff_to_human': {
        const reason = String(input.reason).slice(0, 300);
        const r = await this.tx(tenantId, async (c) => {
          const u = await c.query(`UPDATE conversations SET handler = 'human', status = 'pending', handoff_reason = $2, handoff_at = now() WHERE id = $1 AND handler = 'ai' RETURNING id`, [t.conversationId, reason]);
          if (u.rows[0]) await audit(c, tenantId, null, 'conversation.handoff', 'conversation', t.conversationId, { reason, via: 'workflow', runId: run.id });
          return !!u.rows[0];
        });
        return { handle: 'out', input, output: { handedOff: r, note: r ? undefined : 'Already handled by a person.' } };
      }
      case 'add_note': {
        const r = await this.tx(tenantId, async (c) => {
          const ct = (await c.query(`SELECT id, channel_id, notes FROM contacts WHERE id = $1 FOR UPDATE`, [t.contactId])).rows[0];
          if (!ct) return false;
          const line = `[${new Date().toISOString().slice(0, 10)} workflow] ${text}`;
          const notes = ((ct.notes ? ct.notes + '\n' : '') + line).slice(-4000);
          await c.query(`UPDATE contacts SET notes = $2 WHERE id = $1`, [ct.id, notes]);
          await c.query(`INSERT INTO customer_events (tenant_id, channel_id, contact_id, kind, detail) VALUES ($1, $2, $3, 'details_updated', $4)`, [tenantId, ct.channel_id, ct.id, JSON.stringify({ fields: ['notes'], source: 'workflow' })]);
          return true;
        });
        return r ? { handle: 'out', input, output: { noted: true } } : { handle: null, input, error: 'The customer no longer exists.' };
      }
    }
    return { handle: null, error: 'Unknown action' };
  }

  private async subprocess(tenantId: string, run: RunRow, childWf: string, n: GNode, ctx: Ctx, dry: boolean): Promise<Out> {
    const children = ctx.children as Record<string, string>;
    const key = `${n.id}#${(ctx.visits as any)[n.id]}`;
    if (children[key]) {
      const c = (await this.tx(tenantId, (cl) => cl.query(`SELECT status, error, context FROM workflow_runs WHERE id = $1`, [children[key]]))).rows[0];
      if (!c) return { handle: null, error: 'The child run is missing.' };
      if (c.status === 'completed') return { handle: 'out', output: { childRunId: children[key], vars: (c.context as any)?.vars ?? {} } };
      if (['failed', 'cancelled'].includes(c.status)) return { handle: null, error: `The subprocess ${c.status}${c.error ? `: ${c.error}` : ''}` };
      return { handle: null, output: { childRunId: children[key] }, wait: { kind: 'child' } };
    }
    if (run.depth >= 3) return { handle: null, error: 'Subprocesses can be at most 3 levels deep.' };
    const info = await this.tx(tenantId, async (c) => {
      const w = (await c.query(`SELECT w.id, w.status, w.active_version_id AS avid, w.latest_version AS lv FROM workflows w WHERE w.id = $1`, [childWf])).rows[0];
      if (!w) return { err: 'The subprocess workflow does not exist.' };
      // Ancestors: the same workflow cannot appear twice in one chain.
      const chain = new Set<string>([run.workflowId]); let p = run.parentRunId;
      for (let i = 0; p && i < 5; i++) { const r = (await c.query(`SELECT workflow_id, parent_run_id FROM workflow_runs WHERE id = $1`, [p])).rows[0]; if (!r) break; chain.add(r.workflow_id); p = r.parent_run_id; }
      if (chain.has(childWf)) return { err: 'This workflow is already running in this chain (a circle).' };
      let vid: string;
      if (dry) vid = (await c.query(`SELECT id FROM workflow_versions WHERE workflow_id = $1 AND version = $2`, [childWf, w.lv])).rows[0]?.id;
      else { if (w.status !== 'active' || !w.avid) return { err: 'The subprocess workflow is not active.' }; vid = w.avid; }
      if (!vid) return { err: 'The subprocess workflow has no version.' };
      const trigger = { ...(ctx.trigger as object), parentRunId: run.id };
      const cctx: Ctx = { trigger, customer: ctx.customer ?? {}, conversation: ctx.conversation ?? {}, vars: {}, steps: {}, visits: {}, loops: {}, children: {}, testOptions: ctx.testOptions };
      const r = await c.query(`INSERT INTO workflow_runs (tenant_id, workflow_id, version_id, mode, status, trigger_kind, trigger, context, parent_run_id, parent_node_id, depth) VALUES ($1, $2, $3, $4, 'queued', 'subprocess', $5, $6, $7, $8, $9) RETURNING id`,
        [tenantId, childWf, vid, run.mode, JSON.stringify(trigger), JSON.stringify(cctx), run.id, n.id, run.depth + 1]);
      return { id: r.rows[0].id as string };
    });
    if ('err' in info) return { handle: null, error: info.err };
    children[key] = info.id;
    if (dry) {
      await this.execute(tenantId, info.id);
      const c = (await this.tx(tenantId, (cl) => cl.query(`SELECT status, error, context FROM workflow_runs WHERE id = $1`, [info.id]))).rows[0];
      if (c.status !== 'completed') return { handle: null, output: { childRunId: info.id }, error: `The subprocess ${c.status}${c.error ? `: ${c.error}` : ''}` };
      return { handle: 'out', output: { childRunId: info.id, vars: c.context?.vars ?? {} } };
    }
    return { handle: null, output: { childRunId: info.id }, wait: { kind: 'child' }, childToKick: info.id };
  }

  /* ───────────── human tasks, cancel ───────────── */
  async completeTask(tenantId: string, userId: string, role: string, taskId: string, outcome: 'approved' | 'rejected', note?: string): Promise<void> {
    const runId = await this.tx(tenantId, async (c) => {
      const t = (await c.query(`SELECT id, run_id AS "runId", status, assignee_role AS "assignee" FROM workflow_tasks WHERE id = $1 FOR UPDATE`, [taskId])).rows[0];
      if (!t) throw notFound('Task not found');
      if (t.status !== 'open') throw new AppError(409, 'task_closed', `This task is already ${t.status}.`);
      if ((RANK[role] ?? -1) < RANK[t.assignee]!) throw new AppError(403, 'forbidden', `This task needs a ${t.assignee} or higher.`);
      await c.query(`UPDATE workflow_tasks SET status = 'completed', outcome = $2, note = $3, completed_by = $4, completed_at = now() WHERE id = $1`, [taskId, outcome, note ?? null, userId]);
      await c.query(`UPDATE workflow_runs SET status = 'queued', resume_at = NULL WHERE id = $1 AND status = 'waiting' AND wait_kind = 'task'`, [t.runId]);
      await audit(c, tenantId, userId, 'workflow.task_completed', 'workflow_task', taskId, { outcome });
      return t.runId as string;
    });
    this.kick(tenantId, runId);
  }

  async cancelRun(tenantId: string, userId: string, runId: string): Promise<void> {
    const run = await this.tx(tenantId, async (c) => {
      const r = (await c.query(`UPDATE workflow_runs SET status = 'cancelled', finished_at = now(), locked_at = NULL, resume_at = NULL, error = 'Cancelled by a team member' WHERE id = $1 AND status IN ('queued', 'waiting', 'running') RETURNING ${RUN_COLS}`, [runId])).rows[0];
      if (!r) throw new AppError(409, 'not_cancellable', 'This run is already finished.');
      await c.query(`UPDATE workflow_tasks SET status = 'cancelled' WHERE run_id = $1 AND status = 'open'`, [runId]);
      await audit(c, tenantId, userId, 'workflow.run_cancelled', 'workflow_run', runId, {});
      return r as RunRow;
    });
    await this.onFinished(tenantId, run);
  }

  /* ───────────── background worker ───────────── */
  async tick(): Promise<number> {
    const due = await this.app.pools.app.query('SELECT * FROM worker_workflows_due(20)');
    for (const r of due.rows) await this.execute(r.tenant_id, r.run_id).catch((e) => this.app.log.error({ err: e }, 'workflow tick error'));
    return due.rows.length;
  }
  start(): void { if (this.timer) return; this.timer = setInterval(() => void this.tick().catch((e) => this.app.log.error({ err: e }, 'workflow worker error')), 10_000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

function describe(kind: string, i: Record<string, any>): string {
  switch (kind) {
    case 'send_message': return `Would send to the customer: "${i.text}"`;
    case 'add_tag': return `Would add the tag "${i.tag}"`;
    case 'remove_tag': return `Would remove the tag "${i.tag}"`;
    case 'set_customer_status': return `Would set the customer's status to ${i.status}`;
    case 'set_conversation_status': return `Would set the conversation to ${i.status}`;
    case 'handoff_to_human': return `Would hand the conversation to a person (${i.reason})`;
    default: return `Would add the note "${i.note}"`;
  }
}
export { graphSchema };
