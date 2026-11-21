import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../shared/errors.js';

const COLUMNS = `id, name, job_title AS "jobTitle", description, status, created_at AS "createdAt", updated_at AS "updatedAt"`;

const idParam = z.object({ id: z.uuid() });
const statusEnum = z.enum(['draft', 'active', 'paused']);
const createBody = z.object({
  name: z.string().trim().min(1).max(80),
  jobTitle: z.string().trim().max(120).default(''),
  description: z.string().trim().max(1000).default(''),
  status: statusEnum.default('draft'),
});
const updateBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    jobTitle: z.string().trim().max(120),
    description: z.string().trim().max(1000),
    status: statusEnum,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export async function aiEmployeeRoutes(app: FastifyInstance): Promise<void> {
  const read = [app.authenticate, app.requirePermission('ai_employees:read')];
  const write = [app.authenticate, app.requirePermission('ai_employees:write')];

  app.get('/ai-employees', { preHandler: read }, async (req) => {
    const { rows } = await app.tenantTx(req, (c) => c.query(`SELECT ${COLUMNS} FROM ai_employees ORDER BY created_at DESC LIMIT 200`));
    return { items: rows };
  });

  app.get('/ai-employees/:id', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await app.tenantTx(req, (c) => c.query(`SELECT ${COLUMNS} FROM ai_employees WHERE id = $1`, [id]));
    if (!rows[0]) throw notFound('AI Employee not found');
    return rows[0];
  });

  app.post('/ai-employees', { preHandler: write }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const row = await app.tenantTx(req, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO ai_employees (tenant_id, name, job_title, description, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [req.auth!.tenantId, body.name, body.jobTitle, body.description, body.status, req.auth!.userId],
      );
      await c.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id) VALUES ($1, $2, 'ai_employee.created', 'ai_employee', $3)`,
        [req.auth!.tenantId, req.auth!.userId, rows[0].id],
      );
      return rows[0];
    });
    return reply.status(201).send(row);
  });

  app.patch('/ai-employees/:id', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = updateBody.parse(req.body);
    const map: Record<string, string> = { name: 'name', jobTitle: 'job_title', description: 'description', status: 'status' };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      const v = (body as Record<string, unknown>)[key];
      if (v !== undefined) {
        values.push(v);
        sets.push(`${column} = $${values.length}`);
      }
    }
    values.push(id);
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(`UPDATE ai_employees SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${COLUMNS}`, values),
    );
    if (!rows[0]) throw notFound('AI Employee not found');
    return rows[0];
  });

  app.delete('/ai-employees/:id', { preHandler: write }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const deleted = await app.tenantTx(req, async (c) => {
      const res = await c.query('DELETE FROM ai_employees WHERE id = $1', [id]);
      if (res.rowCount) {
        await c.query(
          `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id) VALUES ($1, $2, 'ai_employee.deleted', 'ai_employee', $3)`,
          [req.auth!.tenantId, req.auth!.userId, id],
        );
      }
      return res.rowCount ?? 0;
    });
    if (!deleted) throw notFound('AI Employee not found');
    return reply.status(204).send();
  });
}
