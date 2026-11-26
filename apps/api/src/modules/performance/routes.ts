import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';

/**
 * Performance dashboard. Every number is computed from recorded rows and comes with its definition.
 * Nothing is estimated. Where the platform cannot know something (e.g. real orders: no order system is connected,
 * or AI cost when the provider did not report one) the response says so instead of showing a made-up value.
 */
const DEFINITIONS = {
  conversations: 'Distinct conversations in which the customer sent at least one message in the period.',
  inboundMessages: 'Messages received from customers in the period.',
  aiReplies: 'Replies written by an AI employee in the period.',
  staffReplies: 'Replies written by a team member in the period.',
  leadsMarked: 'Customers your team (or a workflow) set to status "lead" in the period.',
  leadsCollectedByAi: 'Times an AI employee saved a lead (collect_lead) that the permission engine allowed or a person approved.',
  qualifiedLeads: 'Customers counted above (marked or AI-collected) who have a phone number or email on file. "Qualified" here only means "can be contacted"; MicroAgent has no lead-scoring.',
  orders: 'Order REQUESTS an AI employee made (create_order) that were allowed or approved. No order system is connected, so these are not confirmed, paid or fulfilled orders.',
  conversions: 'Customers set to status "customer" in the period (by your team or a workflow). There is no payment or order integration to prove a sale.',
  handoffs: 'Conversations the AI or a workflow handed to a person in the period.',
  staffTakeovers: 'Conversations where a team member took over from the AI in the period.',
  unanswered: 'Right now: open conversations whose last message is from the customer and is older than the chosen number of minutes.',
  aiTokens: 'Tokens used by AI calls in the period (all calls, including failed ones).',
  aiCost: 'Sum of costs reported by the AI provider. Calls where the provider reported no cost are counted separately and NOT estimated.',
} as const;

export async function performanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/performance', { preHandler: [app.authenticate, app.requirePermission('overview:read')] }, async (req) => {
    const q = z.object({
      from: z.iso.date().optional(), to: z.iso.date().optional(),
      employeeId: z.uuid().optional(), platform: z.enum(['telegram', 'whatsapp', 'messenger', 'instagram', 'website']).optional(), campaignId: z.uuid().optional(),
      unansweredMinutes: z.coerce.number().int().min(5).max(10080).default(60),
    }).parse(req.query);
    const today = new Date().toISOString().slice(0, 10);
    const to = q.to ?? today;
    const from = q.from ?? new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);
    if (from > to) throw new AppError(400, 'validation_error', 'The start date must be before the end date.');
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
    if (days > 366) throw new AppError(400, 'validation_error', 'Choose at most one year.');

    return app.tenantTx(req, async (c) => {
      // [$1 from, $2 to(+1 day), $3 platform, $4 employee, $5 campaign]
      const P = [from, to, q.platform ?? null, q.employeeId ?? null, q.campaignId ?? null];
      const SCOPE = `scope AS (
        SELECT cv.id, cv.contact_id, cv.platform FROM conversations cv
        WHERE ($3::text IS NULL OR cv.platform = $3) AND ($4::uuid IS NULL OR cv.employee_id = $4)
          AND ($5::uuid IS NULL OR cv.contact_id IN (SELECT contact_id FROM campaign_recipients WHERE campaign_id = $5 AND status = 'sent')))`;
      const RANGE = (col: string) => `${col} >= $1::date AND ${col} < ($2::date + 1)`;
      // Every query declares all five parameter types up front (Postgres refuses parameters a statement never mentions).
      const typed = (sql: string) => `WITH _p AS (SELECT $1::date, $2::date, $3::text, $4::uuid, $5::uuid), ` + sql.trim().replace(/^WITH\s+/i, 'WITH ').replace(/^WITH /, '').replace(/^(?!\s*$)/, (m) => m);
      const wrap = (sql: string) => (/^\s*WITH\s/i.test(sql) ? typed(sql) : `WITH _p AS (SELECT $1::date, $2::date, $3::text, $4::uuid, $5::uuid) ${sql}`);
      const one = async (sql: string, extra: unknown[] = []) => (await c.query(wrap(sql), [...P, ...extra])).rows[0] ?? {};
      const filtered = !!(q.platform || q.campaignId);

      const conv = await one(`WITH ${SCOPE} SELECT count(DISTINCT m.conversation_id)::int AS conversations, count(*)::int AS inbound FROM messages m JOIN scope s ON s.id = m.conversation_id WHERE m.direction = 'in' AND ${RANGE('m.created_at')}`);
      const out = await one(`WITH ${SCOPE} SELECT count(*) FILTER (WHERE m.sender_type = 'ai')::int AS ai, count(*) FILTER (WHERE m.sender_type = 'human')::int AS human FROM messages m JOIN scope s ON s.id = m.conversation_id WHERE m.direction = 'out' AND ${RANGE('m.created_at')}`);
      const marked = await one(`WITH ${SCOPE} SELECT count(DISTINCT e.contact_id)::int AS n FROM customer_events e JOIN scope s ON s.contact_id = e.contact_id WHERE e.kind = 'status_changed' AND e.detail->>'to' = 'lead' AND ${RANGE('e.created_at')}`);
      const conversions = await one(`WITH ${SCOPE} SELECT count(DISTINCT e.contact_id)::int AS n FROM customer_events e JOIN scope s ON s.contact_id = e.contact_id WHERE e.kind = 'status_changed' AND e.detail->>'to' = 'customer' AND ${RANGE('e.created_at')}`);
      // AI actions: rows without a conversation cannot be tied to a platform or campaign, so they only count when those filters are off.
      const ACT = (type: string) => `WITH ${SCOPE} SELECT count(*)::int AS n FROM agent_actions a ${filtered ? 'JOIN scope s ON s.id = a.conversation_id' : 'LEFT JOIN scope s ON s.id = a.conversation_id'}
        WHERE a.mode = 'live' AND a.type = '${type}' AND (a.decision = 'allowed' OR a.approval_status = 'approved') AND ($4::uuid IS NULL OR a.employee_id = $4) AND ${RANGE('a.created_at')}`;
      const aiLeads = await one(ACT('collect_lead'));
      const orders = await one(ACT('create_order'));
      const qualified = await one(`WITH ${SCOPE},
        ids AS (
          SELECT e.contact_id FROM customer_events e JOIN scope s ON s.contact_id = e.contact_id WHERE e.kind = 'status_changed' AND e.detail->>'to' = 'lead' AND ${RANGE('e.created_at')}
          UNION
          SELECT s.contact_id FROM agent_actions a JOIN scope s ON s.id = a.conversation_id WHERE a.mode = 'live' AND a.type = 'collect_lead' AND (a.decision = 'allowed' OR a.approval_status = 'approved') AND ${RANGE('a.created_at')})
        SELECT count(*)::int AS n FROM ids JOIN contacts ct ON ct.id = ids.contact_id WHERE ct.phone IS NOT NULL OR ct.email IS NOT NULL`);
      const hand = await one(`WITH ${SCOPE} SELECT count(*) FILTER (WHERE a.action = 'conversation.handoff')::int AS handoffs, count(*) FILTER (WHERE a.action = 'conversation.takeover')::int AS takeovers
        FROM audit_logs a JOIN scope s ON s.id::text = a.entity_id WHERE a.action IN ('conversation.handoff', 'conversation.takeover') AND ${RANGE('a.created_at')}`);
      const unanswered = await one(`WITH ${SCOPE}, last AS (
          SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.direction, m.created_at FROM messages m JOIN scope s ON s.id = m.conversation_id WHERE m.sender_type <> 'system' OR m.direction = 'in' ORDER BY m.conversation_id, m.created_at DESC, m.id DESC)
        SELECT count(*)::int AS n, min(l.created_at) AS oldest FROM last l JOIN conversations cv ON cv.id = l.conversation_id WHERE l.direction = 'in' AND cv.status <> 'resolved' AND l.created_at < now() - make_interval(mins => $6::int)`, [q.unansweredMinutes]);
      const ai = await one(`SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors, COALESCE(sum(total_tokens), 0)::bigint AS tokens,
          COALESCE(sum(cost_usd) FILTER (WHERE cost_source = 'provider'), 0)::float8 AS cost, count(*) FILTER (WHERE cost_usd IS NULL)::int AS "unknownCost"
        FROM ai_usage WHERE ($4::uuid IS NULL OR employee_id = $4) AND ${RANGE('created_at')}`);
      const byPurpose = (await c.query(wrap(`SELECT purpose, count(*)::int AS calls, COALESCE(sum(total_tokens), 0)::bigint AS tokens FROM ai_usage WHERE ($4::uuid IS NULL OR employee_id = $4) AND ${RANGE('created_at')} GROUP BY purpose ORDER BY tokens DESC`), P)).rows;
      const series = (await c.query(wrap(
        `WITH ${SCOPE}, d AS (SELECT g::date AS day FROM generate_series($1::date, $2::date, interval '1 day') g),
           conv AS (SELECT (m.created_at AT TIME ZONE 'utc')::date AS day, count(DISTINCT m.conversation_id)::int AS n FROM messages m JOIN scope s ON s.id = m.conversation_id WHERE m.direction = 'in' AND ${RANGE('m.created_at')} GROUP BY 1),
           tok AS (SELECT (created_at AT TIME ZONE 'utc')::date AS day, sum(total_tokens)::bigint AS n FROM ai_usage WHERE ($4::uuid IS NULL OR employee_id = $4) AND ${RANGE('created_at')} GROUP BY 1)
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(conv.n, 0) AS conversations, COALESCE(tok.n, 0)::bigint AS "aiTokens" FROM d LEFT JOIN conv ON conv.day = d.day LEFT JOIN tok ON tok.day = d.day ORDER BY d.day`), P)).rows;
      const camps = (await c.query(wrap(
        `SELECT id, name, platform, status, started_at AS "startedAt" FROM campaigns
         WHERE status IN ('running', 'paused', 'completed', 'cancelled') AND ($3::text IS NULL OR platform = $3) AND ($5::uuid IS NULL OR id = $5) AND COALESCE(started_at, launched_at) >= $1::date AND COALESCE(started_at, launched_at) < ($2::date + 1)
         ORDER BY COALESCE(started_at, launched_at) DESC LIMIT 20`), P)).rows;
      const campaigns = [];
      for (const k of camps) campaigns.push({ ...k, counts: await app.campaigns.counts(c, k.id) });
      const agents = (await c.query(`SELECT id, name FROM ai_employees ORDER BY name`)).rows;

      return {
        period: { from, to, days },
        filters: { employeeId: q.employeeId ?? null, platform: q.platform ?? null, campaignId: q.campaignId ?? null },
        kpis: {
          conversations: conv.conversations ?? 0, inboundMessages: conv.inbound ?? 0, aiReplies: out.ai ?? 0, staffReplies: out.human ?? 0,
          leadsMarked: marked.n ?? 0, leadsCollectedByAi: aiLeads.n ?? 0, qualifiedLeads: qualified.n ?? 0,
          orders: orders.n ?? 0, conversions: conversions.n ?? 0, handoffs: hand.handoffs ?? 0, staffTakeovers: hand.takeovers ?? 0,
          unanswered: { count: unanswered.n ?? 0, oldestAt: unanswered.oldest ?? null, afterMinutes: q.unansweredMinutes },
          ai: { calls: ai.calls ?? 0, errors: ai.errors ?? 0, tokens: Number(ai.tokens ?? 0), costUsd: ai.cost ?? 0, callsWithoutReportedCost: ai.unknownCost ?? 0, byPurpose: byPurpose.map((r) => ({ ...r, tokens: Number(r.tokens) })) },
        },
        series: series.map((r) => ({ ...r, aiTokens: Number(r.aiTokens) })),
        campaigns,
        agents,
        definitions: DEFINITIONS,
        notes: [
          ...(q.platform ? ['AI usage and cost cannot be split by platform, so those two numbers ignore the platform filter.'] : []),
          ...(q.campaignId ? ['AI usage and cost cannot be tied to a campaign, so those two numbers ignore the campaign filter. Campaign filter = customers who received that campaign.'] : []),
          ...(filtered ? ['AI-collected leads and order requests only count when the AI recorded which conversation they came from.'] : []),
          'Orders are requests recorded by AI employees. MicroAgent has no order or payment system, so real sales are not measured.',
        ],
      };
    });
  });
}
