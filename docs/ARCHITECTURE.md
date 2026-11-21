# MicroAgent — Architecture (Part 1)

## 1. Principles

- **Modular monolith.** One deployable. Modules (`auth`, `tenants`, `team`, `ai-employees`, `overview`, `platform`) are separate folders with their own routes. No microservices until a real need appears.
- **Isolation lives in the database.** The application can have a bug; PostgreSQL still refuses to show one tenant another tenant's rows.
- **No fake data.** Sections that are not built yet show an explicit "Coming in a later phase" state. Every number on screen comes from the database.

## 2. Repository layout

```
apps/api          Fastify API (TypeScript)
  migrations/     0001 schema · 0002 RLS + grants · 0003 auth functions
  src/config      env validation
  src/db          pools, tenant transactions, migration runner
  src/plugins     auth (sessions, permissions), usage metering
  src/shared      errors, RBAC definitions, password/token crypto, mailer
  src/modules     auth · tenants · team · ai-employees · overview · platform
  scripts         create-platform-admin
  test            integration tests (35)
apps/web          React SPA
infra/db/setup.sh DB roles + databases bootstrap
docs/             this file, deploy guide
```

## 3. Multi-tenancy model

Shared database, shared schema, `tenant_id` on every tenant-owned table.

### Three database roles

| Role | Used by | Power |
|---|---|---|
| `microagent_owner` | migrations only | owns tables; never used by the running API |
| `microagent_app` | every tenant request | **RLS applies**; column-level grants; no access to `password_hash`, `token_hash`, `sessions` |
| `microagent_platform` | Platform Admin module only | explicit cross-tenant policies: read tenants/users/employees/usage; update tenant `status`/`plan`; append audit logs. Cannot read secrets or write business data |

None is superuser or `BYPASSRLS` (asserted by a test).

### How a request is isolated

1. The session cookie is resolved to `(user, tenant, role)` by `auth_resolve_session()`.
2. `app.tenantTx(req, fn)` opens a transaction and runs `set_config('app.tenant_id', <id>, true)` (transaction-local, so it can never leak to the next request on a pooled connection).
3. Every policy is `USING (tenant_id = app_current_tenant())`. **No setting = no rows** (fail closed). A malformed value raises an error rather than matching everything.
4. The tenant id comes only from the server-side session — never from the request body, URL or headers.

### Pre-authentication operations

Signup, login lookup, sessions, password reset and invitation acceptance happen before a tenant is known. They are narrow `SECURITY DEFINER` functions (`auth_*`, migration 0003) with a pinned `search_path`, executable only by `microagent_app`. The app role has no direct access to `sessions` or `password_reset_tokens`.

### Guard rails

`test/rls.test.ts` fails the build if a new table with a `tenant_id` column ships without RLS + a policy, or if the app/platform roles get privileges outside the whitelist or `SELECT` on a secret column.

**Rule for future migrations:** a new tenant table must `ENABLE ROW LEVEL SECURITY`, add a policy, grant only the needed columns, and be added to the guard test's expected list.

## 4. Authentication & sessions

- Passwords: scrypt (N=2^15, r=8, p=3), parameters stored in each hash. Minimum 10 characters.
- Session: 256-bit random token in an `httpOnly`, `SameSite=Lax`, `Secure` (production) cookie. Only its SHA-256 is stored. 14-day TTL (configurable). Logout, password reset, disabling a user and suspending a tenant all take effect immediately because sessions are checked in the database on every request.
- Login never reveals whether an email exists (same error, same CPU cost). Disabled/suspended status is only revealed after a correct password.
- Password reset: one-hour single-use token (hashed), response is identical for unknown emails, and a reset revokes every session of that user.
- CSRF: `SameSite=Lax` cookie plus an `Origin` check on every non-GET request against `APP_URL`.
- Rate limits (per IP): login 10/min, signup 5/10 min, forgot/reset password, invitation lookup.
- Headers: Helmet with a strict CSP (`script-src 'self'`).

## 5. RBAC

Roles: `platform_admin`, `owner`, `admin`, `manager`, `viewer`. Single source of truth in `apps/api/src/shared/permissions.ts`; the web app receives the permission list from `/auth/me` and only uses it to hide UI — the API enforces it.

| Permission | owner | admin | manager | viewer |
|---|---|---|---|---|
| overview:read, ai_employees:read, team:read, settings:read | ✅ | ✅ | ✅ | ✅ |
| ai_employees:write | ✅ | ✅ | ✅ | — |
| team:manage, settings:manage | ✅ | ✅ | — | — |

Rules: exactly one owner per tenant (unique index); nobody can change their own role/status; the owner cannot be modified; admins can only manage managers/viewers; platform admins have no access to tenant business routes.

## 6. Database schema (Part 1)

`tenants` · `users` (platform admins have `tenant_id NULL`) · `sessions` · `password_reset_tokens` · `invitations` · `ai_employees` · `usage_daily` (per tenant/day/metric) · `audit_logs` (append-only for the app) · `email_outbox` (dev fallback when SMTP is not configured) · `schema_migrations`.

Decision: **one email = one account = one tenant** in Part 1.

## 7. API (all under `/api/v1`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/signup` `/auth/login` `/auth/logout` `/auth/forgot-password` `/auth/reset-password` `/auth/accept-invitation` · `GET /auth/me` `/auth/invitations/:token` · `PATCH /account` |
| Workspace | `GET/PATCH /tenant` · `GET /overview` |
| Team | `GET /team/members` · `PATCH /team/members/:id` · `GET/POST /team/invitations` · `DELETE /team/invitations/:id` |
| AI Employees | `GET/POST /ai-employees` · `GET/PATCH/DELETE /ai-employees/:id` |
| Platform Admin | `GET /platform/summary` `/platform/tenants` `/platform/tenants/:id` · `PATCH /platform/tenants/:id` |
| Ops | `GET /health` |

Errors: `{ "error": { "code", "message", "details?" } }`. Validation with Zod.

## 8. Usage metering

An `onResponse` hook increments `usage_daily(tenant, day, 'api_requests')`. Later phases add messages, AI tokens, etc. to the same table. Platform Admin sees the monthly total per company.

## 9. Frontend

React SPA, route groups `/app/*` (business) and `/admin` (platform), each behind `RequireAuth` (server session) and `RequirePermission`. Brand tokens (White, Burgundy, Dark Burgundy, Light Gray) are defined once in `apps/web/src/index.css`. The mascot and logo are original SVGs. Animations respect `prefers-reduced-motion`.

## 10. Decisions to keep for later parts

- Keep adding tenant tables with RLS in the same migration; extend the guard test.
- Background jobs (AI calls, channel webhooks) will need either a worker process using the same DB roles or a queue table; decide in Part 2 based on Hostinger plan.
- Channel webhooks are public, tenant-less entry points: resolve tenant from a signed channel id, then use `withTenant`.
- Real email (SMTP) must be configured before onboarding real customers.
