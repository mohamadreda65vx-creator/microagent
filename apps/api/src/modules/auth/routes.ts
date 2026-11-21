import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE, resolveSession, type AuthContext } from '../../plugins/auth.js';
import { withoutTenant } from '../../db/tx.js';
import { AppError, badRequest, conflict, forbidden, pgCode, pgConstraint, unauthorized } from '../../shared/errors.js';
import { ROLE_PERMISSIONS } from '../../shared/permissions.js';
import { fakeVerify, generateToken, hashPassword, hashToken, verifyPassword } from '../../shared/security.js';

const email = z.email().max(254).transform((v) => v.trim().toLowerCase());
const password = z.string().min(10, 'Password must be at least 10 characters').max(128);
const name = (max: number) => z.string().trim().min(1).max(max);

const signupBody = z.object({ businessName: z.string().trim().min(2).max(120), fullName: name(120), email, password });
const loginBody = z.object({ email, password: z.string().min(1).max(128) });
const forgotBody = z.object({ email });
const resetBody = z.object({ token: z.string().min(20).max(200), password });
const acceptBody = z.object({ token: z.string().min(20).max(200), fullName: name(120), password });

const strict = (max: number, windowMs: string) => ({ config: { rateLimit: { max, timeWindow: windowMs } } });

function slugify(businessName: string): string {
  const base = businessName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${base || 'workspace'}-${randomBytes(3).toString('hex')}`;
}

export function mePayload(a: AuthContext) {
  return {
    user: { id: a.userId, email: a.email, fullName: a.fullName, role: a.role },
    tenant: a.tenantId ? { id: a.tenantId, name: a.tenantName, slug: a.tenantSlug } : null,
    permissions: ROLE_PERMISSIONS[a.role],
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { pools, config } = app;
  const secure = config.nodeEnv === 'production';
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;

  /** Creates a session row + cookie for a user, and returns the resolved auth context. */
  async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string): Promise<AuthContext> {
    const token = generateToken();
    const { rows } = await withoutTenant(pools.app, (c) =>
      c.query<{ id: string | null }>('SELECT auth_create_session($1, $2, $3, $4, $5) AS id', [
        userId,
        hashToken(token),
        new Date(Date.now() + ttlMs),
        req.headers['user-agent'] ?? null,
        req.ip,
      ]),
    );
    if (!rows[0]?.id) throw forbidden('This account cannot sign in right now', 'account_disabled');
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: ttlMs / 1000 });
    const resolved = await resolveSession(pools, token);
    if (!resolved) throw new AppError(500, 'session_error', 'Could not start a session');
    return resolved.ctx;
  }

  // ───────────── sign up (creates tenant + owner) ─────────────
  app.post('/auth/signup', strict(5, '10 minutes'), async (req, reply) => {
    const body = signupBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);

    let userId: string | undefined;
    for (let attempt = 0; attempt < 3 && !userId; attempt++) {
      try {
        const { rows } = await withoutTenant(pools.app, (c) =>
          c.query<{ tenant_id: string; user_id: string }>('SELECT * FROM auth_signup($1, $2, $3, $4, $5)', [
            body.businessName,
            slugify(body.businessName),
            body.email,
            passwordHash,
            body.fullName,
          ]),
        );
        userId = rows[0]?.user_id;
      } catch (err) {
        if (pgCode(err) === '23505') {
          if (pgConstraint(err) === 'users_email_key') throw conflict('An account with this email already exists', 'email_taken');
          continue; // slug collision (very rare): retry with a new random suffix
        }
        throw err;
      }
    }
    if (!userId) throw new AppError(500, 'signup_failed', 'Could not create the account, please try again');

    const ctx = await startSession(req, reply, userId);
    return reply.status(201).send(mePayload(ctx));
  });

  // ───────────── login ─────────────
  app.post('/auth/login', strict(10, '1 minute'), async (req, reply) => {
    const body = loginBody.parse(req.body);
    const { rows } = await withoutTenant(pools.app, (c) =>
      c.query<{ user_id: string; password_hash: string; user_status: string; tenant_status: string | null }>(
        'SELECT user_id, password_hash, user_status, tenant_status FROM auth_find_user($1)',
        [body.email],
      ),
    );
    const user = rows[0];
    if (!user) {
      await fakeVerify(body.password);
      throw unauthorized('Invalid email or password', 'invalid_credentials');
    }
    if (!(await verifyPassword(body.password, user.password_hash))) {
      throw unauthorized('Invalid email or password', 'invalid_credentials');
    }
    // Only revealed after the correct password was provided.
    if (user.user_status !== 'active') throw forbidden('This account has been disabled', 'account_disabled');
    if (user.tenant_status && user.tenant_status !== 'active') {
      throw forbidden('This workspace has been suspended. Contact MicroAgent support.', 'tenant_suspended');
    }
    const ctx = await startSession(req, reply, user.user_id);
    return mePayload(ctx);
  });

  // ───────────── logout ─────────────
  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      await withoutTenant(pools.app, (c) => c.query('SELECT auth_revoke_session($1)', [hashToken(token)]));
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  // ───────────── current user ─────────────
  app.get('/auth/me', { preHandler: [app.authenticate] }, async (req) => mePayload(req.auth!));

  app.patch('/account', { preHandler: [app.authenticate] }, async (req) => {
    const body = z.object({ fullName: name(120) }).parse(req.body);
    const a = req.auth!;
    if (!a.tenantId) throw forbidden('Platform admin profile is managed by the platform team', 'no_tenant');
    await app.tenantTx(req, (c) => c.query('UPDATE users SET full_name = $1 WHERE id = $2', [body.fullName, a.userId]));
    return mePayload({ ...a, fullName: body.fullName });
  });

  // ───────────── password reset ─────────────
  app.post('/auth/forgot-password', strict(5, '10 minutes'), async (req) => {
    const body = forgotBody.parse(req.body);
    const token = generateToken();
    const { rows } = await withoutTenant(pools.app, (c) =>
      c.query<{ user_id: string; full_name: string }>('SELECT * FROM auth_create_reset_token($1, $2, $3)', [
        body.email,
        hashToken(token),
        new Date(Date.now() + 60 * 60 * 1000),
      ]),
    );
    const user = rows[0];
    if (user) {
      // Not awaited on purpose: response time must not reveal whether the account exists.
      void app.mailer
        .send({
          to: body.email,
          subject: 'Reset your MicroAgent password',
          text: `Hi ${user.full_name},\n\nUse this link to choose a new password (valid for 1 hour):\n${config.appUrl}/reset-password?token=${token}\n\nIf you did not ask for this, you can ignore this email.`,
        })
        .catch((err) => req.log.error({ err: err.message }, 'failed to send reset email'));
    }
    return { ok: true, message: 'If an account exists for this email, a reset link has been sent.' };
  });

  app.post('/auth/reset-password', strict(10, '10 minutes'), async (req) => {
    const body = resetBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const { rows } = await withoutTenant(pools.app, (c) =>
      c.query<{ ok: boolean }>('SELECT auth_reset_password($1, $2) AS ok', [hashToken(body.token), passwordHash]),
    );
    if (!rows[0]?.ok) throw badRequest('This reset link is invalid or has expired', 'invalid_token');
    return { ok: true };
  });

  // ───────────── team invitations (public side) ─────────────
  app.get('/auth/invitations/:token', strict(30, '1 minute'), async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.params);
    const { rows } = await withoutTenant(pools.app, (c) =>
      c.query<{ tenant_name: string; email: string; role: string; expires_at: string }>('SELECT * FROM auth_peek_invitation($1)', [hashToken(token)]),
    );
    const inv = rows[0];
    if (!inv) throw badRequest('This invitation is invalid or has expired', 'invalid_invitation');
    return { businessName: inv.tenant_name, email: inv.email, role: inv.role, expiresAt: inv.expires_at };
  });

  app.post('/auth/accept-invitation', strict(10, '10 minutes'), async (req, reply) => {
    const body = acceptBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    let userId: string;
    try {
      const { rows } = await withoutTenant(pools.app, (c) =>
        c.query<{ tenant_id: string; user_id: string }>('SELECT * FROM auth_accept_invitation($1, $2, $3)', [
          hashToken(body.token),
          passwordHash,
          body.fullName,
        ]),
      );
      userId = rows[0]!.user_id;
    } catch (err) {
      if ((err as Error).message === 'invalid_invitation') throw badRequest('This invitation is invalid or has expired', 'invalid_invitation');
      if (pgCode(err) === '23505') throw conflict('An account with this email already exists', 'email_taken');
      throw err;
    }
    const ctx = await startSession(req, reply, userId);
    return reply.status(201).send(mePayload(ctx));
  });
}
