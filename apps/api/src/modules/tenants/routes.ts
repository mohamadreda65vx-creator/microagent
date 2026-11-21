import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../shared/errors.js';

const SELECT = `SELECT id, name, slug, status, plan, created_at AS "createdAt" FROM tenants`;

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  // RLS guarantees this query can only ever see the caller's own tenant row.
  app.get('/tenant', { preHandler: [app.authenticate, app.requirePermission('settings:read')] }, async (req) => {
    const { rows } = await app.tenantTx(req, (c) => c.query(SELECT));
    if (!rows[0]) throw notFound('Workspace not found');
    return rows[0];
  });

  app.patch('/tenant', { preHandler: [app.authenticate, app.requirePermission('settings:manage')] }, async (req) => {
    const body = z.object({ name: z.string().trim().min(2).max(120) }).parse(req.body);
    const updated = await app.tenantTx(req, async (c) => {
      const res = await c.query('UPDATE tenants SET name = $1 RETURNING id', [body.name]);
      if (res.rowCount === 0) return null;
      await c.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'tenant.renamed', 'tenant', $3, $4)`,
        [req.auth!.tenantId, req.auth!.userId, req.auth!.tenantId, JSON.stringify({ name: body.name })],
      );
      return (await c.query(SELECT)).rows[0];
    });
    if (!updated) throw notFound('Workspace not found');
    return updated;
  });
}
