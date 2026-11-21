import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, forbidden, notFound, pgCode } from '../../shared/errors.js';
import { assignableRoles, canManageRole, type Role } from '../../shared/permissions.js';
import { generateToken, hashToken } from '../../shared/security.js';

const idParam = z.object({ id: z.uuid() });
const MEMBER_COLUMNS = `id, email, full_name AS "fullName", role, status, last_login_at AS "lastLoginAt", created_at AS "createdAt"`;
const INVITE_COLUMNS = `id, email, role, expires_at AS "expiresAt", created_at AS "createdAt"`;

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  const read = [app.authenticate, app.requirePermission('team:read')];
  const manage = [app.authenticate, app.requirePermission('team:manage')];

  app.get('/team/members', { preHandler: read }, async (req) => {
    const { rows } = await app.tenantTx(req, (c) => c.query(`SELECT ${MEMBER_COLUMNS} FROM users ORDER BY created_at`));
    return { items: rows };
  });

  app.patch('/team/members/:id', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ role: z.enum(['admin', 'manager', 'viewer']).optional(), status: z.enum(['active', 'disabled']).optional() })
      .refine((v) => v.role !== undefined || v.status !== undefined, 'Nothing to update')
      .parse(req.body);
    const actor = req.auth!;
    if (id === actor.userId) throw forbidden('You cannot change your own role or status', 'self_change');

    const member = await app.tenantTx(req, async (c) => {
      const { rows } = await c.query<{ id: string; role: Role }>('SELECT id, role FROM users WHERE id = $1', [id]);
      const target = rows[0];
      if (!target) throw notFound('Team member not found');
      if (!canManageRole(actor.role, target.role)) throw forbidden('You cannot manage this member', 'cannot_manage_role');
      if (body.role && !assignableRoles(actor.role).includes(body.role)) {
        throw forbidden('You cannot assign this role', 'cannot_assign_role');
      }
      const sets: string[] = [];
      const values: unknown[] = [];
      if (body.role) {
        values.push(body.role);
        sets.push(`role = $${values.length}`);
      }
      if (body.status) {
        values.push(body.status);
        sets.push(`status = $${values.length}`);
      }
      values.push(id);
      const updated = await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${MEMBER_COLUMNS}`, values);
      if (body.status === 'disabled') await c.query('SELECT auth_revoke_user_sessions($1)', [id]);
      await c.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, meta) VALUES ($1, $2, 'member.updated', 'user', $3, $4)`,
        [actor.tenantId, actor.userId, id, JSON.stringify(body)],
      );
      return updated.rows[0];
    });
    return member;
  });

  app.get('/team/invitations', { preHandler: read }, async (req) => {
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(`SELECT ${INVITE_COLUMNS} FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`),
    );
    return { items: rows };
  });

  app.post('/team/invitations', { preHandler: manage }, async (req, reply) => {
    const body = z
      .object({
        email: z.email().max(254).transform((v) => v.trim().toLowerCase()),
        role: z.enum(['admin', 'manager', 'viewer']),
      })
      .parse(req.body);
    const actor = req.auth!;
    if (!assignableRoles(actor.role).includes(body.role)) throw forbidden('You cannot invite someone with this role', 'cannot_assign_role');

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    let invitation: Record<string, unknown>;
    try {
      invitation = await app.tenantTx(req, async (c) => {
        const { rows } = await c.query(
          `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${INVITE_COLUMNS}`,
          [actor.tenantId, body.email, body.role, hashToken(token), actor.userId, expiresAt],
        );
        await c.query(
          `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, meta) VALUES ($1, $2, 'invitation.created', 'invitation', $3, $4)`,
          [actor.tenantId, actor.userId, rows[0].id, JSON.stringify({ email: body.email, role: body.role })],
        );
        return rows[0];
      });
    } catch (err) {
      if (pgCode(err) === '23505') throw conflict('This email already has a pending invitation', 'invitation_exists');
      throw err;
    }

    await app.mailer.send({
      to: body.email,
      subject: `${actor.tenantName} invited you to MicroAgent`,
      text: `${actor.fullName} invited you to join ${actor.tenantName} on MicroAgent as ${body.role}.\n\nAccept the invitation (valid for 7 days):\n${app.config.appUrl}/accept-invite?token=${token}\n`,
    });
    return reply.status(201).send(invitation);
  });

  app.delete('/team/invitations/:id', { preHandler: manage }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const revoked = await app.tenantTx(req, async (c) => {
      const res = await c.query('UPDATE invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [id]);
      return res.rowCount ?? 0;
    });
    if (!revoked) throw notFound('Invitation not found');
    return reply.status(204).send();
  });
}
