import type { FastifyInstance } from 'fastify';
import { AiError, type ChatMessage } from '../ai/types.js';
import { extractJson, fitConversation } from '../ai/context.js';
import { withTenant } from '../db/tx.js';
import type { Client } from '../db/pool.js';
import { resolvePermissions } from './catalog.js';
import { evaluateAction, type Decision } from './policy.js';
import { asksForHuman, checkReply, detectAngry, numbersIn, safeReply, type GuardFinding, type SafeKind } from './guards.js';
import { loadEmployee, loadRules, audit, type EmployeeProfile } from './employee.js';
import { knowledgePercents, knowledgePrices, loadKnowledge, retrieve, retrieveMatched, type KnowledgeItem } from './knowledge.js';
import { buildSystemPrompt, effectiveStyle } from './prompt.js';
import { detectLang, findPhone, type Lang } from './text.js';
import type { EffectiveRule } from './effects.js';

export interface TurnInput {
  tenantId: string;
  employeeId: string;
  mode: 'simulation' | 'live';
  history: ChatMessage[]; // previous turns (user/assistant)
  message: string; // the new customer message
  runId?: string | null;
  actorUserId?: string | null;
  /** Simulation only: run against an unsaved/draft configuration without persisting actions. */
  persist?: boolean;
}

export interface TurnResult {
  reply: string;
  modelReply: string | null; // what the model wrote before the guards (shown in simulation only)
  decisions: Decision[];
  findings: GuardFinding[];
  handoff: { reason: string } | null;
  usedModel: boolean;
  usage: { totalTokens: number; costUsd: number | null; model: string } | null;
  facts: Array<{ id: string; kind: string; name: string }>;
  error?: { code: string; message: string };
}

interface Plan {
  employee: EmployeeProfile;
  rules: EffectiveRule[];
  items: KnowledgeItem[];
}

async function loadPlan(c: Client, employeeId: string): Promise<Plan | null> {
  const employee = await loadEmployee(c, employeeId);
  if (!employee) return null;
  return { employee, rules: await loadRules(c, employeeId), items: await loadKnowledge(c, employee) };
}

function lastKnown(history: ChatMessage[], message: string) {
  const customer = [...history.filter((m) => m.role === 'user').map((m) => m.content), message];
  let phone: string | null = null;
  for (const t of customer) phone = findPhone(t) ?? phone;
  return { phone, customerNumbers: customer.flatMap((t) => numbersIn(t)) };
}

/**
 * One turn of an AI employee. Everything the model proposes is re-validated here:
 *  1. hand-off rules are enforced BEFORE any model call (no model can talk its way out of a hand-off);
 *  2. proposed actions go through the Policy Engine (permissions, rules, limits, required fields, approvals);
 *  3. the reply goes through output guards (invented prices, unapproved discounts, stock claims).
 * The same function serves the Playground (mode 'simulation') and, later, live channels.
 */
export async function runTurn(app: FastifyInstance, input: TurnInput): Promise<TurnResult> {
  const { tenantId } = input;
  const plan = await withTenant(app.pools.app, tenantId, (c) => loadPlan(c, input.employeeId));
  if (!plan) throw new Error('employee_not_found');
  const { employee, rules, items } = plan;
  const style = effectiveStyle(employee, rules);
  const lang: Lang = style.language === 'ar' ? 'ar' : style.language === 'en' ? 'en' : detectLang(input.message);
  const egyptian = style.dialect === 'egyptian';
  const known = lastKnown(input.history, input.message);
  const result: TurnResult = { reply: '', modelReply: null, decisions: [], findings: [], handoff: null, usedModel: false, usage: null, facts: [] };

  const ctx = {
    tasks: employee.tasks,
    permissions: employee.permissions,
    rules,
    inventoryConnected: false,
    known: { phone: known.phone },
  };

  // 1. Deterministic hand-off (before the model)
  const angryRule = rules.find((r) => r.effect.type === 'handoff_trigger' && r.effect.trigger === 'angry_customer');
  const humanRule = rules.find((r) => r.effect.type === 'handoff_trigger' && r.effect.trigger === 'customer_requests_human');
  const wantsHuman = asksForHuman(input.message) && (humanRule || employee.tasks.includes('human_handoff'));
  const angry = angryRule && detectAngry(input.message);
  if (wantsHuman || angry) {
    const reason = angry ? 'Customer is upset' : 'Customer asked for a person';
    const d = evaluateAction({ type: 'handoff_to_human', params: { reason, urgency: angry ? 'high' : 'normal' } }, ctx);
    result.decisions.push(d);
    result.handoff = { reason };
    result.reply = safeReply(angry ? 'handoff_upset' : 'handoff_request', lang, egyptian);
    await persist(app, input, result);
    return result;
  }

  // 2. The model
  const facts = retrieve(items, `${input.history.slice(-4).map((m) => m.content).join(' ')} ${input.message}`);
  result.facts = facts.map((f) => ({ id: f.id, kind: f.kind, name: f.name }));
  const system = buildSystemPrompt(employee, rules, facts, style);
  const fit = fitConversation(system, [...input.history, { role: 'user', content: input.message }]);
  let text: string;
  try {
    const res = await app.ai.complete(
      { tenantId, employeeId: employee.id, purpose: input.mode === 'simulation' ? 'simulation' : 'agent_reply' },
      { model: employee.model ?? app.ai.defaultModel, messages: fit.messages, temperature: 0.2, maxTokens: 700, json: true },
    );
    text = res.text;
    result.usedModel = true;
    result.usage = { totalTokens: res.totalTokens, costUsd: res.costUsd, model: res.model };
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    // AI down / not configured / over budget: never improvise. Be honest and offer a human.
    result.error = { code: err.aiCode, message: err.message };
    result.reply = safeReply('action_denied', lang, egyptian);
    const d = evaluateAction({ type: 'handoff_to_human', params: { reason: `AI unavailable (${err.aiCode})`, urgency: 'normal' } }, ctx);
    result.decisions.push(d);
    result.handoff = { reason: `AI unavailable (${err.aiCode})` };
    await persist(app, input, result);
    return result;
  }

  let reply = text.trim();
  let proposed: Array<{ type: string; params: unknown }> = [];
  try {
    const j = extractJson(text) as { reply?: unknown; actions?: unknown };
    if (j && typeof j === 'object' && typeof j.reply === 'string') {
      reply = j.reply.trim();
      if (Array.isArray(j.actions)) proposed = j.actions.slice(0, 5).filter((a): a is { type: string; params: unknown } => !!a && typeof (a as { type?: unknown }).type === 'string');
    }
  } catch {
    /* plain-text answer: no actions */
  }
  result.modelReply = reply;

  // 3. Policy Engine on every proposed action
  for (const a of proposed) result.decisions.push(evaluateAction(a, ctx));
  const handoffNow = result.decisions.find((d) => d.type === 'handoff_to_human' && d.decision === 'allowed');
  if (handoffNow) result.handoff = { reason: String(handoffNow.params.reason ?? 'Requested by the employee') };

  // 4. Output guards
  const perms = resolvePermissions(employee.permissions);
  const discountPerm = perms.give_discount;
  const maxDiscount = discountPerm.mode === 'allow' && !rules.some((r) => r.effect.type === 'prohibit_action' && r.effect.action === 'give_discount') ? (discountPerm.maxPercent ?? 0) : 0;
  result.findings = checkReply(reply, {
    knownPrices: knowledgePrices(items),
    derivedFrom: knowledgePrices(retrieveMatched(items, input.message)),
    customerNumbers: known.customerNumbers,
    knownPercents: knowledgePercents(items),
    maxDiscountPercent: maxDiscount,
    inventoryConnected: false,
    expectedLanguage: style.language === 'auto' ? null : style.language,
  });

  // 5. Choose what the customer actually sees
  const blocking = result.findings.filter((f) => f.severity === 'block');
  const denied = result.decisions.find((d) => d.decision === 'denied');
  const invalid = result.decisions.find((d) => d.decision === 'invalid' && d.reasons.some((r) => r.code === 'missing_required_field'));
  const pending = result.decisions.find((d) => d.decision === 'pending_approval');
  let kind: SafeKind | null = null;
  let field = 'phone';
  if (blocking.some((f) => f.code === 'unapproved_discount') || (denied && denied.type === 'give_discount')) kind = 'discount_denied';
  else if (blocking.some((f) => f.code === 'stock_claim')) kind = 'stock_unknown';
  else if (blocking.some((f) => f.code === 'price_not_in_knowledge')) kind = 'price_unknown';
  else if (denied) kind = 'action_denied';
  else if (invalid) { kind = 'missing_field'; field = invalid.reasons.find((r) => r.code === 'missing_required_field')?.field ?? 'phone'; }
  else if (pending) kind = 'approval_pending';
  result.reply = kind ? safeReply(kind, lang, egyptian, field) : reply || safeReply('invalid_request', lang, egyptian);

  await persist(app, input, result);
  return result;
}

/** Record every proposed action with the backend's decision (and an audit line for denials / approvals). */
async function persist(app: FastifyInstance, input: TurnInput, result: TurnResult): Promise<void> {
  if (input.persist === false || result.decisions.length === 0) return;
  await withTenant(app.pools.app, input.tenantId, async (c) => {
    for (const d of result.decisions) {
      await c.query(
        `INSERT INTO agent_actions (tenant_id, employee_id, run_id, mode, type, params, decision, reasons, approval_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [input.tenantId, input.employeeId, input.runId ?? null, input.mode, d.type, JSON.stringify(d.params), d.decision, JSON.stringify(d.reasons), d.decision === 'pending_approval' ? 'pending' : null],
      );
      if (d.decision !== 'allowed') {
        await audit(c, input.tenantId, input.actorUserId ?? null, `agent_action.${d.decision}`, 'ai_employee', input.employeeId, { type: d.type, mode: input.mode, reasons: d.reasons.map((r) => r.code) });
      }
    }
  });
}
