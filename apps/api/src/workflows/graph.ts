/**
 * Workflow graph: node catalogue, configuration schemas, validation, templates and the condition evaluator.
 * Pure code (no database, no I/O) so every rule here can be unit-tested.
 *
 * This is deliberately NOT a general automation tool: nodes only act on MicroAgent's own objects
 * (conversations, customers, staff tasks, notifications, AI employees). There is no "run arbitrary code" or "call any URL" node.
 */
import { z } from 'zod';

export const NODE_TYPES = ['trigger', 'ai_agent', 'action', 'condition', 'delay', 'notification', 'human_task', 'loop', 'subprocess'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const TRIGGER_KINDS = ['manual', 'message_received', 'conversation_handoff', 'customer_status_changed'] as const;
export const ACTION_KINDS = ['send_message', 'add_tag', 'remove_tag', 'set_customer_status', 'set_conversation_status', 'handoff_to_human', 'add_note'] as const;
export const CONDITION_OPS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'gt', 'lt', 'exists', 'not_exists'] as const;

/** Output handles per node type. An edge must leave from one of these. */
export const HANDLES: Record<NodeType, readonly string[]> = {
  trigger: ['out'], ai_agent: ['out'], action: ['out'], condition: ['true', 'false'], delay: ['out'], notification: ['out'],
  human_task: ['approved', 'rejected', 'timeout'], loop: ['body', 'done'], subprocess: ['out'],
};

export const NODE_INFO: Record<NodeType, { label: string; description: string }> = {
  trigger: { label: 'Trigger', description: 'Starts the workflow: a customer message, a hand-off, a status change, or a manual run.' },
  ai_agent: { label: 'AI Agent', description: 'Asks one of your AI employees to write a text or to choose between options. It never acts by itself.' },
  action: { label: 'Action', description: 'Does something real: message the customer, tag, change status, hand off, add a note.' },
  condition: { label: 'Condition', description: 'Splits the path with a true / false check on the data.' },
  delay: { label: 'Delay', description: 'Waits minutes, hours or days, then continues.' },
  notification: { label: 'Notification', description: 'Sends an in-app notification to your team.' },
  human_task: { label: 'Human Task', description: 'Waits for a team member to approve or reject, then continues on that branch.' },
  loop: { label: 'Loop', description: 'Repeats the steps on its "body" output for each item or N times, then continues on "done".' },
  subprocess: { label: 'Subprocess', description: 'Runs another active workflow and waits for it to finish.' },
};

const ident = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, 'use lowercase letters, numbers and _');
const tpl = (max: number) => z.string().trim().min(1).max(max);
const platform = z.enum(['telegram', 'whatsapp', 'messenger', 'instagram', 'website']);

export const CONFIG = {
  trigger: z.object({
    kind: z.enum(TRIGGER_KINDS),
    platforms: z.array(platform).max(5).optional(),
    containsAny: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    toStatus: z.enum(['new', 'lead', 'customer', 'inactive']).optional(),
  }).strict(),
  ai_agent: z.object({
    employeeId: z.uuid(), mode: z.enum(['text', 'choice']), prompt: tpl(2000), outputVar: ident,
    choices: z.array(z.string().trim().min(1).max(40)).min(2).max(8).optional(),
  }).strict(),
  action: z.object({
    kind: z.enum(ACTION_KINDS), text: tpl(1500).optional(), tag: z.string().trim().min(1).max(40).optional(),
    status: z.string().trim().max(20).optional(), reason: tpl(300).optional(), note: tpl(500).optional(),
  }).strict(),
  condition: z.object({
    match: z.enum(['all', 'any']),
    rules: z.array(z.object({ left: tpl(200), op: z.enum(CONDITION_OPS), right: z.string().max(200).optional() }).strict()).min(1).max(10),
  }).strict(),
  delay: z.object({ amount: z.number().int().min(1).max(43200), unit: z.enum(['minutes', 'hours', 'days']) }).strict(),
  notification: z.object({ roles: z.array(z.enum(['owner', 'admin', 'manager'])).min(1).max(3), title: tpl(120), body: z.string().trim().max(1000).default('') }).strict(),
  human_task: z.object({ title: tpl(200), instructions: z.string().trim().max(2000).default(''), assigneeRole: z.enum(['owner', 'admin', 'manager']), dueHours: z.number().int().min(1).max(720).optional() }).strict(),
  loop: z.object({ source: z.enum(['count', 'list']), count: z.number().int().min(1).max(100).optional(), listVar: z.string().trim().max(100).optional() }).strict(),
  subprocess: z.object({ workflowId: z.uuid() }).strict(),
} satisfies Record<NodeType, z.ZodType>;

/** Shape of what the editor saves. Semantic problems are reported by validateGraph(), not here, so drafts can be saved half-built. */
export const graphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    type: z.enum(NODE_TYPES),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    data: z.record(z.string(), z.unknown()).default({}),
  }).strict()).max(60),
  edges: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    source: z.string(), target: z.string(), sourceHandle: z.string().max(20).optional().nullable(),
  }).strict()).max(150),
}).strict();
export type Graph = z.infer<typeof graphSchema>;
export type GNode = Graph['nodes'][number];

export interface Issue { level: 'error' | 'warning'; nodeId?: string; code: string; message: string }

export interface ValidationEnv {
  /** Employees that exist in the tenant: id → status. */
  employees: Map<string, string>;
  /** Other workflows in the tenant: id → has an active version. */
  workflows: Map<string, { active: boolean }>;
  selfId?: string;
}

const handleOf = (e: { sourceHandle?: string | null }, type: NodeType) => e.sourceHandle ?? HANDLES[type][0]!;

export function validateGraph(g: Graph, env: ValidationEnv): Issue[] {
  const issues: Issue[] = [];
  const err = (code: string, message: string, nodeId?: string) => issues.push({ level: 'error', code, message, ...(nodeId ? { nodeId } : {}) });
  const warn = (code: string, message: string, nodeId?: string) => issues.push({ level: 'warning', code, message, ...(nodeId ? { nodeId } : {}) });
  const byId = new Map<string, GNode>();
  for (const n of g.nodes) { if (byId.has(n.id)) err('duplicate_node', `Two nodes share the id ${n.id}`, n.id); byId.set(n.id, n); }

  const triggers = g.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) err('no_trigger', 'Add a Trigger node: it is where the workflow starts.');
  if (triggers.length > 1) err('many_triggers', 'A workflow has exactly one Trigger node.');

  // Per-node configuration
  for (const n of g.nodes) {
    const p = CONFIG[n.type].safeParse(n.data);
    if (!p.success) { err('bad_config', `${NODE_INFO[n.type].label}: ${p.error.issues[0]?.path.join('.') || 'settings'} ${p.error.issues[0]?.message ?? 'is invalid'}`, n.id); continue; }
    const d = p.data as Record<string, any>;
    if (n.type === 'ai_agent') {
      if (!env.employees.has(d.employeeId)) err('employee_missing', 'The AI employee chosen here does not exist.', n.id);
      else if (env.employees.get(d.employeeId) !== 'active') warn('employee_inactive', 'This AI employee is not active, so the step will fail until it is activated.', n.id);
      if (d.mode === 'choice' && !d.choices) err('choices_missing', 'Choice mode needs 2 to 8 options.', n.id);
    }
    if (n.type === 'action') {
      const need: Record<string, keyof typeof d> = { send_message: 'text', add_tag: 'tag', remove_tag: 'tag', set_customer_status: 'status', set_conversation_status: 'status', handoff_to_human: 'reason', add_note: 'note' };
      const f = need[d.kind];
      if (f && !d[f]) err('action_incomplete', `"${d.kind.replace(/_/g, ' ')}" needs a value for ${String(f)}.`, n.id);
      if (d.kind === 'set_customer_status' && d.status && !['new', 'lead', 'customer', 'inactive'].includes(d.status)) err('bad_status', 'Customer status must be new, lead, customer or inactive.', n.id);
      if (d.kind === 'set_conversation_status' && d.status && !['open', 'pending', 'resolved'].includes(d.status)) err('bad_status', 'Conversation status must be open, pending or resolved.', n.id);
      if ((d.kind === 'add_tag' || d.kind === 'remove_tag') && d.tag && !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u.test(d.tag)) err('bad_tag', 'Tags use letters, numbers, spaces, - and _.', n.id);
    }
    if (n.type === 'condition') for (const r of d.rules) if (!['exists', 'not_exists'].includes(r.op) && (r.right === undefined || r.right === '')) err('rule_incomplete', 'Each condition needs a value to compare with.', n.id);
    if (n.type === 'delay' && toMs(d.amount, d.unit) > 30 * 86400_000) err('delay_too_long', 'The longest delay is 30 days.', n.id);
    if (n.type === 'loop') {
      if (d.source === 'count' && !d.count) err('loop_count', 'Set how many times to repeat (1 to 100).', n.id);
      if (d.source === 'list' && !d.listVar) err('loop_list', 'Name the list in the data to loop over, for example trigger.items.', n.id);
    }
    if (n.type === 'subprocess') {
      if (d.workflowId === env.selfId) err('subprocess_self', 'A workflow cannot run itself.', n.id);
      else if (!env.workflows.has(d.workflowId)) err('subprocess_missing', 'The workflow chosen here does not exist.', n.id);
      else if (!env.workflows.get(d.workflowId)!.active) warn('subprocess_inactive', 'That workflow is not active yet. A live run would fail here until it is activated.', n.id);
    }
  }

  // Edges
  const out = new Map<string, Array<{ handle: string; target: string }>>();
  const seen = new Set<string>();
  for (const e of g.edges) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) { err('dangling_edge', 'A connection points to a node that no longer exists.'); continue; }
    const h = handleOf(e, s.type);
    if (!HANDLES[s.type].includes(h)) { err('bad_handle', `${NODE_INFO[s.type].label} has no "${h}" output.`, s.id); continue; }
    if (t.type === 'trigger') { err('into_trigger', 'Nothing can lead into the Trigger.', t.id); continue; }
    if (e.source === e.target) { err('self_loop', 'A node cannot connect to itself.', s.id); continue; }
    const key = `${e.source}:${h}`;
    if (seen.has(key)) { err('two_edges', `The "${h}" output of ${NODE_INFO[s.type].label} goes to two places. Each output has one path.`, s.id); continue; }
    seen.add(key);
    if (!out.has(s.id)) out.set(s.id, []);
    out.get(s.id)!.push({ handle: h, target: t.id });
  }

  // Reachability
  const start = triggers[0];
  if (start) {
    const reach = new Set<string>([start.id]);
    const stack = [start.id];
    while (stack.length) for (const x of out.get(stack.pop()!) ?? []) if (!reach.has(x.target)) { reach.add(x.target); stack.push(x.target); }
    for (const n of g.nodes) if (!reach.has(n.id)) err('unreachable', `${NODE_INFO[n.type].label} is not connected to the Trigger, so it would never run.`, n.id);
  }

  // Cycles are only allowed when they pass through a Loop node (which has a hard iteration limit).
  for (const comp of sccs(g.nodes.map((n) => n.id), out)) {
    const cyc = comp.length > 1;
    if (cyc && !comp.some((id) => byId.get(id)!.type === 'loop')) err('cycle', 'These nodes form a circle with no Loop node, which could run forever. Use a Loop node to repeat steps.', comp[0]);
  }

  // Outputs left open
  for (const n of g.nodes) {
    const used = new Set((out.get(n.id) ?? []).map((x) => x.handle));
    if (n.type === 'condition' && !used.has('true') && !used.has('false')) warn('condition_open', 'Neither the true nor the false output is connected.', n.id);
    else if (n.type === 'condition' && (!used.has('true') || !used.has('false'))) warn('branch_open', `The ${used.has('true') ? 'false' : 'true'} path ends the workflow.`, n.id);
    if (n.type === 'human_task' && !used.has('approved') && !used.has('rejected')) warn('task_open', 'Connect the approved and/or rejected output, otherwise the answer changes nothing.', n.id);
    if (n.type === 'loop' && !used.has('body')) err('loop_no_body', 'Connect the "body" output to the steps to repeat.', n.id);
    if (n.type === 'loop' && used.has('body')) {
      // The body must come back to the loop, otherwise only the first item is processed.
      const seenB = new Set<string>(); const st = [(out.get(n.id) ?? []).find((x) => x.handle === 'body')!.target]; let back = false;
      while (st.length) { const x = st.pop()!; if (x === n.id) { back = true; break; } if (seenB.has(x)) continue; seenB.add(x); for (const y of out.get(x) ?? []) st.push(y.target); }
      if (!back) err('loop_no_return', 'The last step of the loop body must connect back to the Loop node, or only one item is processed.', n.id);
    }
  }
  return issues;
}

function sccs(ids: string[], out: Map<string, Array<{ target: string }>>): string[][] {
  let idx = 0; const index = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), st: string[] = [], res: string[][] = [];
  const go = (v: string) => {
    index.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const { target: w } of out.get(v) ?? []) {
      if (!index.has(w)) { go(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) { const c: string[] = []; let w: string; do { w = st.pop()!; on.delete(w); c.push(w); } while (w !== v); res.push(c); }
  };
  for (const v of ids) if (!index.has(v)) go(v);
  return res;
}

export const toMs = (amount: number, unit: 'minutes' | 'hours' | 'days') => amount * { minutes: 60_000, hours: 3600_000, days: 86400_000 }[unit];

/** The next node for a given output handle, or null when the path ends there. */
export function nextNode(g: Graph, nodeId: string, handle: string): string | null {
  const n = g.nodes.find((x) => x.id === nodeId);
  if (!n) return null;
  const e = g.edges.find((x) => x.source === nodeId && (x.sourceHandle ?? HANDLES[n.type][0]) === handle);
  return e?.target ?? null;
}

/* ───────────── templates and conditions (no eval, no code execution) ───────────── */
export type Ctx = Record<string, unknown>;

export function getPath(ctx: Ctx, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.trim().split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
const show = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Replaces {{path}} with data from the run. Anything missing is reported, never invented. */
export function render(template: string, ctx: Ctx): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, p: string) => {
    const v = getPath(ctx, p);
    if (v === undefined || v === null || v === '') { missing.push(p); return ''; }
    return show(v);
  });
  return { text, missing };
}

export function evalRule(rule: { left: string; op: (typeof CONDITION_OPS)[number]; right?: string }, ctx: Ctx): boolean {
  const L = render(rule.left, ctx).text.trim(), R = render(rule.right ?? '', ctx).text.trim();
  const ln = Number(L), rn = Number(R), numeric = L !== '' && R !== '' && Number.isFinite(ln) && Number.isFinite(rn);
  switch (rule.op) {
    case 'equals': return numeric ? ln === rn : L.toLowerCase() === R.toLowerCase();
    case 'not_equals': return numeric ? ln !== rn : L.toLowerCase() !== R.toLowerCase();
    case 'contains': return L.toLowerCase().includes(R.toLowerCase());
    case 'not_contains': return !L.toLowerCase().includes(R.toLowerCase());
    case 'starts_with': return L.toLowerCase().startsWith(R.toLowerCase());
    case 'gt': return numeric && ln > rn;
    case 'lt': return numeric && ln < rn;
    case 'exists': return L !== '';
    case 'not_exists': return L === '';
  }
}
export const evalCondition = (c: { match: 'all' | 'any'; rules: Array<{ left: string; op: (typeof CONDITION_OPS)[number]; right?: string }> }, ctx: Ctx): { result: boolean; details: Array<{ rule: string; result: boolean }> } => {
  const details = c.rules.map((r) => ({ rule: `${r.left} ${r.op}${r.right ? ' ' + r.right : ''}`, result: evalRule(r, ctx) }));
  return { result: c.match === 'all' ? details.every((d) => d.result) : details.some((d) => d.result), details };
};

/** The starting graph of a new workflow: just the trigger. */
export const STARTER_GRAPH: Graph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 80, y: 120 }, data: { kind: 'manual' } }], edges: [] };
