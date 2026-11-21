-- 0001_core_schema.sql
-- Core multi-tenant schema. Runs as microagent_owner.
-- Tenancy model: shared database, shared schema, `tenant_id` on every tenant-owned table.
-- Isolation is enforced by PostgreSQL Row Level Security (see 0002), not by the application.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

-- ───────────────────────── tenants (one row per business) ─────────────────────────
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  slug        citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan        text NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'starter', 'growth', 'scale')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ───────────────────────── users ─────────────────────────
-- Platform admins have tenant_id NULL. Everyone else belongs to exactly one tenant.
-- Email is globally unique: one email = one account = one tenant (Phase 1 decision).
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,
  email          citext NOT NULL UNIQUE CHECK (char_length(email) BETWEEN 3 AND 254),
  password_hash  text NOT NULL,
  full_name      text NOT NULL CHECK (char_length(btrim(full_name)) BETWEEN 1 AND 120),
  role           text NOT NULL CHECK (role IN ('platform_admin', 'owner', 'admin', 'manager', 'viewer')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_tenant_matches_role CHECK (
    (role = 'platform_admin' AND tenant_id IS NULL) OR
    (role <> 'platform_admin' AND tenant_id IS NOT NULL)
  )
);
CREATE INDEX users_tenant_idx ON users (tenant_id);
-- Exactly one Business Owner per tenant.
CREATE UNIQUE INDEX users_one_owner_per_tenant ON users (tenant_id) WHERE role = 'owner';
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ───────────────────────── sessions (opaque tokens, stored hashed) ─────────────────────────
-- Not reachable by the app role directly: only through auth_* SECURITY DEFINER functions.
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ───────────────────────── password reset ─────────────────────────
CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_user_idx ON password_reset_tokens (user_id);

-- ───────────────────────── invitations (team) ─────────────────────────
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       citext NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  role        text NOT NULL CHECK (role IN ('admin', 'manager', 'viewer')),
  token_hash  bytea NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_tenant_idx ON invitations (tenant_id);
CREATE UNIQUE INDEX invitations_one_pending_per_email
  ON invitations (tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ───────────────────────── AI employees (Phase 1: the record only) ─────────────────────────
CREATE TABLE ai_employees (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  job_title    text NOT NULL DEFAULT '' CHECK (char_length(job_title) <= 120),
  description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_employees_tenant_idx ON ai_employees (tenant_id, created_at DESC);
CREATE TRIGGER ai_employees_updated_at BEFORE UPDATE ON ai_employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ───────────────────────── usage metering ─────────────────────────
-- One row per tenant / UTC day / metric. Phase 1 records `api_requests`.
-- Later phases add: messages, ai_tokens, conversations, ...
CREATE TABLE usage_daily (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day        date NOT NULL DEFAULT ((now() AT TIME ZONE 'utc')::date),
  metric     text NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_.]{1,60}$'),
  quantity   bigint NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (tenant_id, day, metric)
);

-- ───────────────────────── audit log (append-only for the app) ─────────────────────────
CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid REFERENCES tenants(id) ON DELETE SET NULL,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_idx ON audit_logs (tenant_id, created_at DESC);

-- ───────────────────────── email outbox (development fallback) ─────────────────────────
-- Used only when SMTP is not configured. Lets us test reset/invitation flows for real
-- without pretending an email was delivered.
CREATE TABLE email_outbox (
  id          bigserial PRIMARY KEY,
  to_email    citext NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
