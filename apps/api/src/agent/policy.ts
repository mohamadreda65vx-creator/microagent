import { ACTIONS, ACTION_SCHEMAS, isActionType, resolvePermissions, type ActionType, type PermissionConfig } from './catalog.js';
import type { EffectiveRule } from './effects.js';

export type DecisionKind = 'allowed' | 'denied' | 'pending_approval' | 'invalid';

export interface Reason {
  code: string;
  message: string;
  ruleId?: string;
  field?: string;
}

export interface PolicyContext {
  tasks: readonly string[];
  permissions: PermissionConfig | null | undefined;
  rules: EffectiveRule[];
  /** True only when a live inventory source is connected. Not available in Part 2. */
  inventoryConnected: boolean;
  /** Facts the customer already gave in this conversation. */
  known: { phone?: string | null; name?: string | null; email?: string | null };
  now?: Date;
}

export interface ProposedAction {
  type: string;
  params: unknown;
}

export interface Decision {
  type: string;
  params: Record<string, unknown>;
  decision: DecisionKind;
  reasons: Reason[];
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * The permissions engine. Pure and deterministic: no model, no prompt. The AI only PROPOSES an action;
 * this function decides whether it is allowed, needs a human's approval, is refused, or is malformed.
 *
 * Order: validate shape → task gating → employee permission → company rules (rules can only RESTRICT) → limits → required fields.
 * Precedence of the outcome: denied > invalid > pending_approval > allowed.
 */
export function evaluateAction(proposed: ProposedAction, ctx: PolicyContext): Decision {
  if (!isActionType(proposed.type)) {
    return { type: String(proposed.type).slice(0, 60), params: asObject(proposed.params), decision: 'invalid', reasons: [{ code: 'unknown_action', message: `"${String(proposed.type).slice(0, 60)}" is not an action this platform supports.` }] };
  }
  const type: ActionType = proposed.type;
  const parsed = ACTION_SCHEMAS[type].safeParse(proposed.params ?? {});
  if (!parsed.success) {
    return {
      type,
      params: asObject(proposed.params),
      decision: 'invalid',
      reasons: parsed.error.issues.map((i) => ({ code: 'invalid_params', message: `${i.path.join('.') || 'params'}: ${i.message}`, field: String(i.path[0] ?? '') })),
    };
  }
  const params = parsed.data as Record<string, unknown>;

  // Handing a conversation to a human is the safety valve: it can never be blocked.
  if (type === 'handoff_to_human') return { type, params, decision: 'allowed', reasons: [] };

  const denied: Reason[] = [];
  const invalid: Reason[] = [];
  const approval: Reason[] = [];
  const info = ACTIONS[type];

  if (info.tasks.length > 0 && !info.tasks.some((t) => ctx.tasks.includes(t))) {
    denied.push({ code: 'task_not_enabled', message: `This employee is not assigned a task that allows "${info.label}".` });
  }

  const perm = resolvePermissions(ctx.permissions)[type];
  if (perm.mode === 'deny') denied.push({ code: 'permission_denied', message: `"${info.label}" is not permitted for this employee.` });
  if (perm.mode === 'require_approval') approval.push({ code: 'approval_required', message: `"${info.label}" needs a person's approval.` });

  for (const rule of ctx.rules) {
    const e = rule.effect;
    if (e.type === 'prohibit_action' && e.action === type) denied.push({ code: 'blocked_by_rule', message: `Blocked by rule: ${rule.instruction}`, ruleId: rule.id });
    if (e.type === 'require_approval' && e.action === type) approval.push({ code: 'approval_required', message: `Rule requires approval: ${rule.instruction}`, ruleId: rule.id });
    if (e.type === 'require_field' && e.before_action === type) {
      const have =
        e.field === 'phone' ? (params.customer_phone ?? params.phone ?? ctx.known.phone)
        : e.field === 'name' ? (params.customer_name ?? params.name ?? ctx.known.name)
        : (params.email ?? ctx.known.email);
      if (!have) invalid.push({ code: 'missing_required_field', message: `The customer's ${e.field} is required first: ${rule.instruction}`, ruleId: rule.id, field: e.field });
    }
  }

  if (perm.mode !== 'deny') {
    if (type === 'give_discount') {
      if (typeof params.percent === 'number' && params.percent > (perm.maxPercent ?? 0)) denied.push({ code: 'exceeds_limit', message: `A ${params.percent}% discount is above the allowed ${perm.maxPercent ?? 0}%.` });
      if (typeof params.amount === 'number' && params.amount > (perm.maxAmount ?? 0)) denied.push({ code: 'exceeds_limit', message: `A discount of ${params.amount} is above the allowed ${perm.maxAmount ?? 0}.` });
    }
    if (type === 'issue_refund' && (params.amount as number) > (perm.maxAmount ?? 0)) denied.push({ code: 'exceeds_limit', message: `A refund of ${params.amount} is above the allowed ${perm.maxAmount ?? 0}.` });
    if (type === 'create_order' && perm.maxAmount !== undefined && typeof params.total === 'number' && params.total > perm.maxAmount) {
      approval.push({ code: 'above_limit_needs_approval', message: `An order total of ${params.total} is above ${perm.maxAmount}: a person must approve it.` });
    }
  }
  if (type === 'create_booking' && Date.parse(params.datetime as string) < (ctx.now ?? new Date()).getTime()) {
    invalid.push({ code: 'datetime_in_past', message: 'The booking time is in the past.', field: 'datetime' });
  }
  if (type === 'check_inventory' && !ctx.inventoryConnected) {
    denied.push({ code: 'inventory_not_connected', message: 'No inventory source is connected, so stock cannot be checked or stated.' });
  }

  if (denied.length) return { type, params, decision: 'denied', reasons: [...denied, ...invalid, ...approval] };
  if (invalid.length) return { type, params, decision: 'invalid', reasons: [...invalid, ...approval] };
  if (approval.length) return { type, params, decision: 'pending_approval', reasons: approval };
  return { type, params, decision: 'allowed', reasons: [] };
}
