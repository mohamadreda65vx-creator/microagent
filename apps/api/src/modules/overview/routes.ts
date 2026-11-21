import type { FastifyInstance } from 'fastify';

export async function overviewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/overview', { preHandler: [app.authenticate, app.requirePermission('overview:read')] }, async (req) => {
    return app.tenantTx(req, async (c) => {
      const ai = await c.query<{ status: string; n: number }>('SELECT status, count(*) AS n FROM ai_employees GROUP BY status');
      const members = await c.query<{ n: number }>("SELECT count(*) AS n FROM users WHERE status = 'active'");
      const invites = await c.query<{ n: number }>(
        'SELECT count(*) AS n FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()',
      );
      const daily = await c.query<{ day: string; quantity: number }>(
        `SELECT to_char(g.day, 'YYYY-MM-DD') AS day, COALESCE(u.quantity, 0) AS quantity
         FROM generate_series((now() AT TIME ZONE 'utc')::date - 13, (now() AT TIME ZONE 'utc')::date, interval '1 day') AS g(day)
         LEFT JOIN usage_daily u ON u.day = g.day::date AND u.metric = 'api_requests'
         ORDER BY g.day`,
      );
      const byStatus = Object.fromEntries(ai.rows.map((r) => [r.status, r.n]));
      const total = ai.rows.reduce((s, r) => s + r.n, 0);
      const month = await c.query<{ n: number }>(
        `SELECT COALESCE(sum(quantity), 0)::bigint AS n FROM usage_daily
         WHERE metric = 'api_requests' AND day >= date_trunc('month', now() AT TIME ZONE 'utc')::date`,
      );
      const apiRequestsMonth = month.rows[0]!.n;
      return {
        aiEmployees: { total, active: byStatus.active ?? 0, draft: byStatus.draft ?? 0, paused: byStatus.paused ?? 0 },
        team: { members: members.rows[0]!.n, pendingInvitations: invites.rows[0]!.n },
        usage: { apiRequestsMonth, dailyApiRequests: daily.rows.map((r) => ({ day: r.day, count: r.quantity })) },
        onboarding: { hasAiEmployee: total > 0, hasTeammate: members.rows[0]!.n > 1 || invites.rows[0]!.n > 0 },
      };
    });
  });
}
