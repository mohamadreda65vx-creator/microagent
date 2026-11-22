import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../shared/errors.js';

/**
 * Platform Admin module. Uses the separate `microagent_platform` database role, whose
 * cross-tenant access is limited by explicit policies (read tenants/users/employees/usage,
 * update tenant status/plan, append audit logs). It cannot read password hashes or sessions.
 */
const MONTH_START = `date_trunc('month', now() AT TIME ZONE 'utc')::date`;

const TENANT_ROW = `
  t.id, t.name, t.slug, t.status, t.plan, t.created_at AS "createdAt",
  (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS "usersCount",
  (SELECT count(*) FROM ai_employees a WHERE a.tenant_id = t.id) AS "aiEmployeesCount",
  COALESCE((SELECT sum(d.quantity) FROM usage_daily d WHERE d.tenant_id = t.id AND d.metric = 'api_requests' AND d.day >= ${MONTH_START}), 0)::bigint AS "apiRequestsMonth",
  (SELECT max(u.last_login_at) FROM users u WHERE u.tenant_id = t.id) AS "lastLoginAt",
  t.ai_monthly_token_limit AS "aiMonthlyTokenLimit",
  COALESCE((SELECT sum(a.total_tokens) FROM ai_usage a WHERE a.tenant_id = t.id AND a.created_at >= date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'), 0)::bigint AS "aiTokensMonth",
  (SELECT sum(a.cost_usd) FROM ai_usage a WHERE a.tenant_id = t.id AND a.created_at >= date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')::float8 AS "aiCostMonthUsd"`;

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  const pre = [app.authenticate, app.requirePlatformAdmin];
  const db = () => app.pools.platform;

  app.get('/platform/summary', { preHandler: pre }, async () => {
    const { rows } = await db().query(`
      SELECT
        (SELECT count(*) FROM tenants) AS "companies",
        (SELECT count(*) FROM tenants WHERE status = 'active') AS "activeCompanies",
        (SELECT count(*) FROM tenants WHERE status = 'suspended') AS "suspendedCompanies",
        (SELECT count(*) FROM users WHERE tenant_id IS NOT NULL) AS "users",
        (SELECT count(*) FROM ai_employees) AS "aiEmployees",
        COALESCE((SELECT sum(quantity) FROM usage_daily WHERE metric = 'api_requests' AND day >= ${MONTH_START}), 0)::bigint AS "apiRequestsMonth",
        (SELECT count(*) FROM tenants WHERE created_at >= now() - interval '30 days') AS "newCompanies30d"`);
    return rows[0];
  });

  app.get('/platform/tenants', { preHandler: pre }, async (req) => {
    const q = z
      .object({
        search: z.string().trim().max(100).optional(),
        status: z.enum(['active', 'suspended']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    const search = q.search ? `%${q.search.replace(/[\\%_]/g, '\\$&')}%` : null;
    const params = [search, q.status ?? null];
    const where = `WHERE ($1::text IS NULL OR t.name ILIKE $1 OR t.slug::text ILIKE $1) AND ($2::text IS NULL OR t.status = $2)`;
    const total = await db().query<{ n: number }>(`SELECT count(*) AS n FROM tenants t ${where}`, params);
    const { rows } = await db().query(
      `SELECT ${TENANT_ROW} FROM tenants t ${where} ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { items: rows, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize };
  });

  app.get('/platform/tenants/:id', { preHandler: pre }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rows } = await db().query(`SELECT ${TENANT_ROW} FROM tenants t WHERE t.id = $1`, [id]);
    if (!rows[0]) throw notFound('Company not found');
    return rows[0];
  });

  /** Per-company monthly AI token budget. null = use the platform default (AI_MONTHLY_TOKEN_LIMIT); 0 = AI disabled for this company. */
  app.patch('/platform/tenants/:id/ai-limit', { preHandler: pre }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ aiMonthlyTokenLimit: z.number().int().min(0).max(1_000_000_000).nullable() }).parse(req.body);
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      const res = await client.query('UPDATE tenants SET ai_monthly_token_limit = $1 WHERE id = $2 RETURNING id', [body.aiMonthlyTokenLimit, id]);
      if (res.rowCount === 0) throw notFound('Company not found');
      await client.query(`INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, meta) VALUES ($1, $2, 'tenant.ai_limit_changed', 'tenant', $3, $4)`, [id, req.auth!.userId, id, JSON.stringify({ aiMonthlyTokenLimit: body.aiMonthlyTokenLimit })]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const { rows } = await db().query(`SELECT ${TENANT_ROW} FROM tenants t WHERE t.id = $1`, [id]);
    return rows[0];
  });

  app.patch('/platform/tenants/:id', { preHandler: pre }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ status: z.enum(['active', 'suspended']) }).parse(req.body);
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      const res = await client.query('UPDATE tenants SET status = $1 WHERE id = $2 RETURNING id', [body.status, id]);
      if (res.rowCount === 0) {
        await client.query('ROLLBACK');
        throw notFound('Company not found');
      }
      await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, $3, 'tenant', $4, $5)`,
        [id, req.auth!.userId, body.status === 'suspended' ? 'tenant.suspended' : 'tenant.activated', id, JSON.stringify({ by: 'platform_admin' })],
      );
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      client.release();
    }
    const { rows } = await db().query(`SELECT ${TENANT_ROW} FROM tenants t WHERE t.id = $1`, [id]);
    return rows[0];
  });
}
