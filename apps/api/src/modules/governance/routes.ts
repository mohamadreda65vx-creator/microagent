import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../agent/employee.js';
import { AppError, notFound } from '../../shared/errors.js';

const ACTION_COLUMNS = `a.id, a.employee_id AS "employeeId", e.name AS "employeeName", a.mode, a.type, a.params, a.decision, a.reasons,
  a.approval_status AS "approvalStatus", a.decided_at AS "decidedAt", a.decision_note AS "decisionNote", a.created_at AS "createdAt", u.full_name AS "decidedByName"`;

export async function governanceRoutes(app: FastifyInstance): Promise<void> {
  const readApprovals = [app.authenticate, app.requirePermission('approvals:read')];
  const decide = [app.authenticate, app.requirePermission('approvals:decide')];
  const readAudit = [app.authenticate, app.requirePermission('audit:read')];

  /** Everything employees proposed that needs a person (or was refused), newest first. */
  app.get('/approvals', { preHandler: readApprovals }, async (req) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'), mode: z.enum(['live', 'simulation', 'all']).default('live'), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const where = (q.status === 'all' ? `a.decision = 'pending_approval'` : `a.approval_status = '${q.status}'`) + (q.mode === 'all' ? '' : ` AND a.mode = '${q.mode}'`);
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(`SELECT ${ACTION_COLUMNS} FROM agent_actions a JOIN ai_employees e ON e.id = a.employee_id LEFT JOIN users u ON u.id = a.decided_by WHERE ${where} ORDER BY a.created_at DESC LIMIT $1`, [q.limit]),
    );
    return { items: rows };
  });

  app.get('/agent-actions', { preHandler: readApprovals }, async (req) => {
    const q = z.object({ employeeId: z.uuid().optional(), decision: z.enum(['allowed', 'denied', 'pending_approval', 'invalid']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(
        `SELECT ${ACTION_COLUMNS} FROM agent_actions a JOIN ai_employees e ON e.id = a.employee_id LEFT JOIN users u ON u.id = a.decided_by
         WHERE ($1::uuid IS NULL OR a.employee_id = $1) AND ($2::text IS NULL OR a.decision = $2) ORDER BY a.created_at DESC LIMIT $3`,
        [q.employeeId ?? null, q.decision ?? null, q.limit],
      ),
    );
    return { items: rows };
  });

  // An approval is decided ONCE (the database enforces it too).
  app.post('/approvals/:id/decision', { preHandler: decide }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).optional() }).parse(req.body);
    return app.tenantTx(req, async (c) => {
      const { rows } = await c.query(
        `UPDATE agent_actions SET approval_status = $2, decided_by = $3, decided_at = now(), decision_note = $4
         WHERE id = $1 AND approval_status = 'pending' RETURNING id, employee_id AS "employeeId", type, mode, approval_status AS "approvalStatus"`,
        [id, body.decision, req.auth!.userId, body.note ?? null],
      );
      if (!rows[0]) {
        const exists = await c.query('SELECT approval_status FROM agent_actions WHERE id = $1', [id]);
        if (!exists.rows[0]) throw notFound('Approval not found');
        throw new AppError(409, 'approval_already_decided', 'This request was already decided');
      }
      await audit(c, req.auth!.tenantId!, req.auth!.userId, `approval.${body.decision}`, 'agent_action', id, { type: rows[0].type, employeeId: rows[0].employeeId, mode: rows[0].mode });
      return rows[0];
    });
  });

  app.get('/audit-logs', { preHandler: readAudit }, async (req) => {
    const q = z.object({ entityType: z.string().max(60).optional(), action: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional() }).parse(req.query);
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(
        `SELECT l.id, l.action, l.entity_type AS "entityType", l.entity_id AS "entityId", l.meta, l.created_at AS "createdAt", u.full_name AS "actorName"
         FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_user_id
         WHERE ($1::text IS NULL OR l.entity_type = $1) AND ($2::text IS NULL OR l.action LIKE $2 || '%') AND ($3::bigint IS NULL OR l.id < $3)
         ORDER BY l.id DESC LIMIT $4`,
        [q.entityType ?? null, q.action ?? null, q.before ?? null, q.limit],
      ),
    );
    return { items: rows, next: rows.length === q.limit ? rows[rows.length - 1].id : null };
  });
}
