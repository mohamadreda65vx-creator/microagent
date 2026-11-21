-- 0003_auth_functions.sql
-- Pre-authentication operations (signup, login lookup, sessions, password reset, invitations).
-- These must work BEFORE a tenant is known, so they cannot go through Row Level Security.
-- Instead of giving the app role broad table access, each operation is a narrow
-- SECURITY DEFINER function owned by microagent_owner, executable only by microagent_app.
--
-- Every function pins search_path to avoid search-path hijacking.

-- ───────────── signup: tenant + owner, atomically ─────────────
CREATE FUNCTION auth_signup(
  p_business_name text, p_slug citext, p_email citext, p_password_hash text, p_full_name text
) RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid;
  v_user uuid;
BEGIN
  INSERT INTO tenants (name, slug) VALUES (p_business_name, p_slug) RETURNING id INTO v_tenant;
  INSERT INTO users (tenant_id, email, password_hash, full_name, role)
    VALUES (v_tenant, p_email, p_password_hash, p_full_name, 'owner') RETURNING id INTO v_user;
  INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id)
    VALUES (v_tenant, v_user, 'tenant.created', 'tenant', v_tenant::text);
  RETURN QUERY SELECT v_tenant, v_user;
END
$$;

-- ───────────── login lookup ─────────────
CREATE FUNCTION auth_find_user(p_email citext)
RETURNS TABLE (
  user_id uuid, tenant_id uuid, email citext, password_hash text, full_name text,
  role text, user_status text, tenant_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.email, u.password_hash, u.full_name, u.role, u.status, t.status
  FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
  WHERE u.email = p_email
$$;

-- ───────────── sessions ─────────────
CREATE FUNCTION auth_create_session(
  p_user_id uuid, p_token_hash bytea, p_expires_at timestamptz, p_user_agent text, p_ip text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_session uuid;
BEGIN
  -- Refuse to create a session for a disabled user or a suspended tenant.
  IF NOT EXISTS (
    SELECT 1 FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
    WHERE u.id = p_user_id AND u.status = 'active' AND (u.tenant_id IS NULL OR t.status = 'active')
  ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip)
    VALUES (p_user_id, p_token_hash, p_expires_at, left(p_user_agent, 300), left(p_ip, 64))
    RETURNING id INTO v_session;
  UPDATE users SET last_login_at = now() WHERE id = p_user_id;
  RETURN v_session;
END
$$;

CREATE FUNCTION auth_resolve_session(p_token_hash bytea)
RETURNS TABLE (
  session_id uuid, user_id uuid, tenant_id uuid, email citext, full_name text, role text,
  user_status text, tenant_status text, tenant_name text, tenant_slug citext
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, u.id, u.tenant_id, u.email, u.full_name, u.role, u.status,
         t.status, t.name, t.slug
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  LEFT JOIN tenants t ON t.id = u.tenant_id
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
$$;

CREATE FUNCTION auth_revoke_session(p_token_hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE sessions SET revoked_at = now() WHERE token_hash = p_token_hash AND revoked_at IS NULL
$$;

-- Revokes all sessions of a user, but ONLY if that user belongs to the tenant of the current
-- transaction (set via app.tenant_id). A tenant can never revoke another tenant's sessions.
CREATE FUNCTION auth_revoke_user_sessions(p_user_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE sessions s SET revoked_at = now()
  WHERE s.user_id = p_user_id AND s.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.tenant_id = app_current_tenant());
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- ───────────── password reset ─────────────
CREATE FUNCTION auth_create_reset_token(p_email citext, p_token_hash bytea, p_expires_at timestamptz)
RETURNS TABLE (user_id uuid, full_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_name text;
BEGIN
  SELECT u.id, u.full_name INTO v_user, v_name FROM users u WHERE u.email = p_email AND u.status = 'active';
  IF v_user IS NULL THEN
    RETURN;
  END IF;
  UPDATE password_reset_tokens SET used_at = now() WHERE user_id = v_user AND used_at IS NULL;
  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (v_user, p_token_hash, p_expires_at);
  RETURN QUERY SELECT v_user, v_name;
END
$$;

CREATE FUNCTION auth_reset_password(p_token_hash bytea, p_password_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_token uuid;
  v_user uuid;
BEGIN
  SELECT id, user_id INTO v_token, v_user FROM password_reset_tokens
  WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  FOR UPDATE;
  IF v_token IS NULL THEN
    RETURN false;
  END IF;
  UPDATE password_reset_tokens SET used_at = now() WHERE id = v_token;
  UPDATE users SET password_hash = p_password_hash WHERE id = v_user;
  -- A password reset signs the user out everywhere.
  UPDATE sessions SET revoked_at = now() WHERE user_id = v_user AND revoked_at IS NULL;
  RETURN true;
END
$$;

-- ───────────── invitations ─────────────
CREATE FUNCTION auth_peek_invitation(p_token_hash bytea)
RETURNS TABLE (tenant_name text, email citext, role text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.name, i.email, i.role, i.expires_at
  FROM invitations i JOIN tenants t ON t.id = i.tenant_id
  WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL
    AND i.expires_at > now() AND t.status = 'active'
$$;

CREATE FUNCTION auth_accept_invitation(p_token_hash bytea, p_password_hash text, p_full_name text)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_inv invitations%ROWTYPE;
  v_user uuid;
BEGIN
  SELECT i.* INTO v_inv FROM invitations i JOIN tenants t ON t.id = i.tenant_id
  WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL
    AND i.expires_at > now() AND t.status = 'active'
  FOR UPDATE OF i;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'invalid_invitation' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO users (tenant_id, email, password_hash, full_name, role)
    VALUES (v_inv.tenant_id, v_inv.email, p_password_hash, p_full_name, v_inv.role)
    RETURNING id INTO v_user;
  UPDATE invitations SET accepted_at = now() WHERE id = v_inv.id;
  INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id)
    VALUES (v_inv.tenant_id, v_user, 'invitation.accepted', 'invitation', v_inv.id::text);
  RETURN QUERY SELECT v_inv.tenant_id, v_user;
END
$$;

-- ───────────── permissions: only the app role may call auth_* ─────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'auth\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO microagent_app', r.sig);
  END LOOP;
END
$$;
