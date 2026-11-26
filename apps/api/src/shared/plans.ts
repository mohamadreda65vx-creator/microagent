/**
 * Plan limits. These are DEFAULTS chosen for the first release, not commercial claims:
 * the platform admin can override any of them per company (tenants.limits) and change the plan by hand.
 * MicroAgent has no payment processor: plan and subscription status are set manually by the platform admin.
 */
export const LIMIT_KEYS = ['maxAiEmployees', 'maxChannels', 'maxMonthlyMessages'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type Limits = Record<LimitKey, number>;
export const PLANS = ['trial', 'starter', 'growth', 'scale'] as const;
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled'] as const;

export const PLAN_LIMITS: Record<(typeof PLANS)[number], Limits> = {
  trial: { maxAiEmployees: 2, maxChannels: 2, maxMonthlyMessages: 1_000 },
  starter: { maxAiEmployees: 5, maxChannels: 5, maxMonthlyMessages: 10_000 },
  growth: { maxAiEmployees: 20, maxChannels: 15, maxMonthlyMessages: 100_000 },
  scale: { maxAiEmployees: 100, maxChannels: 50, maxMonthlyMessages: 1_000_000 },
};

export function effectiveLimits(plan: string, override: unknown): Limits {
  const base = { ...(PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.trial) };
  if (override && typeof override === 'object') for (const k of LIMIT_KEYS) { const v = (override as Record<string, unknown>)[k]; if (typeof v === 'number' && Number.isFinite(v) && v >= 0) base[k] = Math.floor(v); }
  return base;
}
