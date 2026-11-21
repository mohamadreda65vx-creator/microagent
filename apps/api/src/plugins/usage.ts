import type { FastifyInstance } from 'fastify';
import { withTenant } from '../db/tx.js';

/**
 * Usage metering. Counts authenticated API requests per tenant per UTC day.
 * Runs after the response is sent, so it never slows a request down or breaks it.
 * Later phases will add more metrics (messages, AI tokens, ...) to the same table.
 */
export function registerUsageMetering(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId || reply.statusCode >= 500) return;
    try {
      await withTenant(app.pools.app, tenantId, (c) =>
        c.query(
          `INSERT INTO usage_daily (tenant_id, metric, quantity) VALUES ($1, 'api_requests', 1)
           ON CONFLICT (tenant_id, day, metric) DO UPDATE SET quantity = usage_daily.quantity + 1`,
          [tenantId],
        ),
      );
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'usage metering failed');
    }
  });
}
