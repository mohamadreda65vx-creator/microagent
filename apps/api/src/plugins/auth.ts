import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config/env.js';
import type { Client, Pools } from '../db/pool.js';
import { withTenant } from '../db/tx.js';
import { forbidden, unauthorized } from '../shared/errors.js';
import { can, type Permission, type Role } from '../shared/permissions.js';
import { hashToken } from '../shared/security.js';
import type { Mailer } from '../shared/mailer.js';
import type { AiService } from '../ai/service.js';
import type { CampaignEngine } from '../campaigns/engine.js';
import type { ChannelManager } from '../channels/manager.js';

export const SESSION_COOKIE = 'ma_session';

export interface AuthContext {
  sessionId: string;
  userId: string;
  /** null only for platform admins */
  tenantId: string | null;
  role: Role;
  email: string;
  fullName: string;
  tenantName: string | null;
  tenantSlug: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    pools: Pools;
    config: Config;
    mailer: Mailer;
    ai: AiService;
    channels: ChannelManager;
    campaigns: CampaignEngine;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (permission: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePlatformAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Run queries as the authenticated user's tenant. Row Level Security applies. */
    tenantTx: <T>(req: FastifyRequest, fn: (c: Client) => Promise<T>) => Promise<T>;
  }
}

interface SessionRow {
  session_id: string;
  user_id: string;
  tenant_id: string | null;
  email: string;
  full_name: string;
  role: Role;
  user_status: string;
  tenant_status: string | null;
  tenant_name: string | null;
  tenant_slug: string | null;
}

export async function resolveSession(pools: Pools, token: string): Promise<{ ctx: AuthContext; tenantStatus: string | null; userStatus: string } | null> {
  const { rows } = await pools.app.query<SessionRow>('SELECT * FROM auth_resolve_session($1)', [hashToken(token)]);
  const r = rows[0];
  if (!r) return null;
  return {
    userStatus: r.user_status,
    tenantStatus: r.tenant_status,
    ctx: {
      sessionId: r.session_id,
      userId: r.user_id,
      tenantId: r.tenant_id,
      role: r.role,
      email: r.email,
      fullName: r.full_name,
      tenantName: r.tenant_name,
      tenantSlug: r.tenant_slug,
    },
  };
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('auth', null);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw unauthorized();
    const resolved = await resolveSession(app.pools, token);
    if (!resolved || resolved.userStatus !== 'active') throw unauthorized('Session expired', 'session_expired');
    if (resolved.ctx.tenantId && resolved.tenantStatus !== 'active') {
      throw forbidden('This workspace has been suspended. Contact MicroAgent support.', 'tenant_suspended');
    }
    req.auth = resolved.ctx;
  });

  app.decorate('requirePermission', (permission: Permission) => async (req: FastifyRequest) => {
    if (!req.auth) throw unauthorized();
    if (!can(req.auth.role, permission)) throw forbidden();
  });

  app.decorate('requirePlatformAdmin', async (req: FastifyRequest) => {
    if (!req.auth) throw unauthorized();
    if (req.auth.role !== 'platform_admin') throw forbidden();
  });

  app.decorate('tenantTx', <T>(req: FastifyRequest, fn: (c: Client) => Promise<T>): Promise<T> => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw forbidden('This action requires a business workspace', 'no_tenant');
    return withTenant(app.pools.app, tenantId, fn);
  });
}
