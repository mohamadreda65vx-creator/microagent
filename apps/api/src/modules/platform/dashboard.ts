import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, notFound } from '../../shared/errors.js';
import { LIMIT_KEYS, PLANS, SUBSCRIPTION_STATUSES, effectiveLimits, type Limits } from '../../shared/plans.js';

const MONTH = `date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`;

/**
 * Super Admin dashboard. Uses only the platform database role: tenant rows, employees and AI usage it may already read,
 * plus aggregate-only SQL functions for channels and messages (counts, never content). All numbers are measured, none estimated.
 */
export async function platformDashboardRoutes(app: FastifyInstance): Promise<void> {
  const pre = [app.authenticate, app.requirePlatformAdmin];
  const db = () => app.pools.platform;

  app.get('/platform/dashboard', { preHandler: pre }, async (req) => {
    const days = z.coerce.number().int().min(1).max(90).default(30).parse((req.query as Record<string, unknown>).days);
    const one = async (sql: string, p: unknown[] = []) => (await db().query(sql, p)).rows[0] ?? {};

    const tenants = await one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
        count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS "new30d",
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = tenants.id AND u.last_login_at >= now() - interval '7 days'))::int AS "signedIn7d",
        count(*) FILTER (WHERE subscription_status = 'trialing' AND trial_ends_at < now())::int AS "trialsExpired" FROM tenants`);
    const byPlan = (await db().query(`SELECT plan, count(*)::int AS n FROM tenants GROUP BY plan ORDER BY n DESC`)).rows;
    const bySub = (await db().query(`SELECT subscription_status AS status, count(*)::int AS n FROM tenants GROUP BY 1 ORDER BY n DESC`)).rows;
    const employees = await one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active FROM ai_employees`);
    const chan = (await db().query(`SELECT * FROM platform_channel_stats()`)).rows as Array<{ type: string; status: string; n: string }>;
    const volume = (await db().query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, inbound::int, ai_out::int AS "aiOut", human_out::int AS "humanOut", system_out::int AS "systemOut", failed::int FROM platform_message_volume($1)`, [days])).rows;
    const ai = await one(`SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors, COALESCE(sum(total_tokens), 0)::bigint AS tokens,
        COALESCE(sum(cost_usd) FILTER (WHERE cost_source = 'provider'), 0)::float8 AS cost, count(*) FILTER (WHERE cost_usd IS NULL)::int AS "unknownCost"
        FROM ai_usage WHERE created_at >= now() - make_interval(days => $1)`, [days]);
    const aiDaily = (await db().query(`SELECT to_char((created_at AT TIME ZONE 'utc')::date, 'YYYY-MM-DD') AS day, sum(total_tokens)::bigint AS tokens, count(*)::int AS calls FROM ai_usage WHERE created_at >= now() - make_interval(days => $1) GROUP BY 1 ORDER BY 1`, [days])).rows;
    const aiTop = (await db().query(`SELECT t.id, t.name, sum(a.total_tokens)::bigint AS tokens, count(*)::int AS calls FROM ai_usage a JOIN tenants t ON t.id = a.tenant_id WHERE a.created_at >= now() - make_interval(days => $1) GROUP BY t.id, t.name ORDER BY tokens DESC LIMIT 8`, [days])).rows;
    const failures = await one(`SELECT * FROM platform_failure_counts()`);
    const errByCode = (await db().query(`SELECT source, code, count(*)::int AS n, max(created_at) AS "lastAt" FROM system_errors WHERE created_at >= now() - interval '24 hours' GROUP BY 1, 2 ORDER BY n DESC LIMIT 15`)).rows;
    const errRecent = (await db().query(`SELECT e.id::int, e.source, e.code, e.message, e.created_at AS "createdAt", t.name AS "tenantName" FROM system_errors e LEFT JOIN tenants t ON t.id = e.tenant_id ORDER BY e.id DESC LIMIT 20`)).rows;

    // Usage vs limits per company
    const counts = new Map((await db().query(`SELECT * FROM platform_tenant_counts()`)).rows.map((r: any) => [r.tenant_id as string, r]));
    const rows = (await db().query(`SELECT t.id, t.name, t.plan, t.status, t.subscription_status AS "subscriptionStatus", t.trial_ends_at AS "trialEndsAt", t.limits, t.ai_monthly_token_limit AS "tokenLimit",
        (SELECT count(*)::int FROM ai_employees e WHERE e.tenant_id = t.id) AS employees,
        COALESCE((SELECT sum(a.total_tokens) FROM ai_usage a WHERE a.tenant_id = t.id AND a.created_at >= ${MONTH}), 0)::bigint AS "tokensMonth" FROM tenants t ORDER BY t.created_at DESC LIMIT 500`)).rows;
    const defaultTokens = app.config.ai.monthlyTokenLimit;
    const usage = rows.map((t: any) => {
      const c: any = counts.get(t.id) ?? {};
      const lim = effectiveLimits(t.plan, t.limits);
      const used = { maxAiEmployees: t.employees as number, maxChannels: Number(c.channels ?? 0), maxMonthlyMessages: Number(c.messages_month ?? 0) };
      const tokenLimit = typeof t.tokenLimit === 'number' ? t.tokenLimit : defaultTokens;
      const pct = (u: number, l: number) => (l > 0 ? Math.round((u / l) * 100) : u > 0 ? 100 : 0);
      const meters = [
        ...LIMIT_KEYS.map((k) => ({ key: k, used: used[k], limit: lim[k], percent: pct(used[k], lim[k]) })),
        { key: 'aiTokensMonth', used: Number(t.tokensMonth), limit: tokenLimit, percent: pct(Number(t.tokensMonth), tokenLimit) },
      ];
      return { id: t.id, name: t.name, plan: t.plan, status: t.status, subscriptionStatus: t.subscriptionStatus, trialEndsAt: t.trialEndsAt, meters, nearLimit: meters.some((m) => m.percent >= 80), overridden: Object.keys(t.limits ?? {}).length > 0, connectedChannels: Number(c.connected_channels ?? 0), campaignsMonth: Number(c.campaigns_month ?? 0), workflowRunsMonth: Number(c.workflow_runs_month ?? 0) };
    });

    return {
      days,
      tenants: { ...tenants, byPlan, bySubscription: bySub, activeDefinition: 'Active = account not suspended. "Signed in 7d" = at least one team member logged in during the last 7 days.' },
      aiEmployees: employees,
      channels: { total: chan.reduce((s, r) => s + Number(r.n), 0), connected: chan.filter((r) => r.status === 'connected').reduce((s, r) => s + Number(r.n), 0), byTypeStatus: chan.map((r) => ({ type: r.type, status: r.status, count: Number(r.n) })) },
      messageVolume: { series: volume, totals: volume.reduce((a: any, r: any) => ({ inbound: a.inbound + r.inbound, aiOut: a.aiOut + r.aiOut, humanOut: a.humanOut + r.humanOut, systemOut: a.systemOut + r.systemOut, failed: a.failed + r.failed }), { inbound: 0, aiOut: 0, humanOut: 0, systemOut: 0, failed: 0 }) },
      aiConsumption: { calls: ai.calls, errors: ai.errors, tokens: Number(ai.tokens), costUsd: ai.cost, callsWithoutReportedCost: ai.unknownCost, daily: aiDaily.map((r: any) => ({ ...r, tokens: Number(r.tokens) })), topCompanies: aiTop.map((r: any) => ({ ...r, tokens: Number(r.tokens) })) },
      errors: { last24h: { failedMessages: Number(failures.failed_messages_24h), failedCampaignMessages: Number(failures.failed_campaign_messages_24h), failedWorkflowRuns: Number(failures.failed_workflow_runs_24h), webhookRejectedOrErrors: Number(failures.webhook_errors_24h) }, channelsInError: Number(failures.channel_errors), byCode: errByCode, recent: errRecent },
      usageLimits: { note: 'Limits are defaults per plan that you can override per company. Employees, channels and campaign messages are enforced; AI tokens use the monthly token budget.', companies: usage },
      privacy: 'This dashboard shows counts and metadata only. It never shows message text, customer data or credentials.',
    };
  });

  /** Plan, subscription status, trial end and per-company limit overrides. Set by hand: no payment processor is connected. */
  app.patch('/platform/tenants/:id/subscription', { preHandler: pre }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({
      plan: z.enum(PLANS).optional(), subscriptionStatus: z.enum(SUBSCRIPTION_STATUSES).optional(),
      trialEndsAt: z.iso.datetime().nullable().optional(),
      limits: z.object({ maxAiEmployees: z.number().int().min(0).max(100000).nullable().optional(), maxChannels: z.number().int().min(0).max(100000).nullable().optional(), maxMonthlyMessages: z.number().int().min(0).max(100_000_000).nullable().optional() }).strict().optional(),
    }).strict().refine((x) => Object.keys(x).length > 0, 'Nothing to change').parse(req.body);
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      const cur = (await client.query(`SELECT plan, subscription_status AS "subscriptionStatus", trial_ends_at AS "trialEndsAt", limits FROM tenants WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound('Company not found');
      let limits = cur.limits ?? {};
      if (b.limits) { limits = { ...limits }; for (const [k, v] of Object.entries(b.limits)) { if (v === null) delete limits[k]; else if (v !== undefined) limits[k] = v; } }
      const plan = b.plan ?? cur.plan;
      await client.query(
        `UPDATE tenants SET plan = $2, subscription_status = $3, trial_ends_at = $4, limits = $5, plan_changed_at = CASE WHEN $2 <> plan THEN now() ELSE plan_changed_at END WHERE id = $1`,
        [id, plan, b.subscriptionStatus ?? cur.subscriptionStatus, b.trialEndsAt === undefined ? cur.trialEndsAt : b.trialEndsAt, JSON.stringify(limits)]);
      await client.query(`INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, meta) VALUES ($1, $2, 'tenant.subscription_changed', 'tenant', $4, $3)`, [id, req.auth!.userId, JSON.stringify({ by: 'platform_admin', before: { plan: cur.plan, status: cur.subscriptionStatus, limits: cur.limits }, after: { plan, status: b.subscriptionStatus ?? cur.subscriptionStatus, limits } }), id]);
      await client.query('COMMIT');
      return { id, plan, subscriptionStatus: b.subscriptionStatus ?? cur.subscriptionStatus, limits, effective: effectiveLimits(plan, limits) satisfies Limits };
    } catch (e) { try { await client.query('ROLLBACK'); } catch { /* already */ } throw e instanceof AppError ? e : e; }
    finally { client.release(); }
  });
}
