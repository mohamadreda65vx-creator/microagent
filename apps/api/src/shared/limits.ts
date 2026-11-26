import type { Client } from '../db/pool.js';
import { AppError } from './errors.js';
import { effectiveLimits, type LimitKey } from './plans.js';

const LABEL: Record<LimitKey, string> = { maxAiEmployees: 'AI employees', maxChannels: 'channels', maxMonthlyMessages: 'messages this month' };

/** Limits of the company the transaction is running for (row-level security scopes it). */
export async function limitsFor(c: Client) {
  const t = (await c.query(`SELECT plan, limits FROM tenants WHERE id = app_current_tenant()`)).rows[0];
  return effectiveLimits(t?.plan ?? 'trial', t?.limits);
}
export async function usageOf(c: Client, key: LimitKey): Promise<number> {
  const sql: Record<LimitKey, string> = {
    maxAiEmployees: `SELECT count(*)::int AS n FROM ai_employees`,
    maxChannels: `SELECT count(*)::int AS n FROM channels`,
    maxMonthlyMessages: `SELECT count(*)::int AS n FROM messages WHERE direction = 'out' AND created_at >= date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`,
  };
  return (await c.query(sql[key])).rows[0].n as number;
}
/** Refuses with a clear message when adding `adding` more would pass the plan limit. */
export async function enforceLimit(c: Client, tenantId: string, key: LimitKey, adding = 1): Promise<void> {
  const [lim, used] = [(await limitsFor(c))[key], await usageOf(c, key)];
  if (used + adding > lim) throw new AppError(402, 'plan_limit', `Your plan allows ${lim} ${LABEL[key]} and you have ${used}. Ask the platform admin to raise the limit.`, { key, limit: lim, used });
}
