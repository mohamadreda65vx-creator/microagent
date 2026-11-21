-- 0002_rls_policies_grants.sql
-- Tenant isolation at the DATABASE level.
--
-- Roles:
--   microagent_owner    owns the tables (bypasses RLS as table owner). Migrations + auth_* functions only.
--   microagent_app      every tenant request. RLS applies. Can only see rows of the tenant set in
--                       the transaction-local setting `app.tenant_id`. Fail-closed: no setting = no rows.
--   microagent_platform Platform Admin module only. Explicit, narrow cross-tenant policies.
--
-- RULE FOR FUTURE MIGRATIONS: every new table with a tenant_id column MUST enable RLS and add a
-- policy in the same migration. test/rls-guard.test.ts fails the build if one is forgotten.

CREATE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Lock everything down first, then grant only what is needed.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, microagent_app, microagent_platform;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, microagent_app, microagent_platform;

ALTER TABLE tenants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_employees  ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_daily   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs    ENABLE ROW LEVEL SECURITY;

-- ───────────── tenants ─────────────
GRANT SELECT (id, name, slug, status, plan, created_at, updated_at) ON tenants TO microagent_app;
GRANT UPDATE (name) ON tenants TO microagent_app;
CREATE POLICY tenants_app_select ON tenants FOR SELECT TO microagent_app
  USING (id = app_current_tenant());
CREATE POLICY tenants_app_update ON tenants FOR UPDATE TO microagent_app
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

GRANT SELECT ON tenants TO microagent_platform;
GRANT UPDATE (status, plan) ON tenants TO microagent_platform;
CREATE POLICY tenants_platform_select ON tenants FOR SELECT TO microagent_platform USING (true);
CREATE POLICY tenants_platform_update ON tenants FOR UPDATE TO microagent_platform USING (true) WITH CHECK (true);

-- ───────────── users (password_hash is never readable by the app) ─────────────
-- No INSERT/DELETE for the app: users are created only through auth_* functions.
GRANT SELECT (id, tenant_id, email, full_name, role, status, last_login_at, created_at, updated_at)
  ON users TO microagent_app, microagent_platform;
GRANT UPDATE (full_name, role, status) ON users TO microagent_app;
CREATE POLICY users_app_select ON users FOR SELECT TO microagent_app
  USING (tenant_id = app_current_tenant());
CREATE POLICY users_app_update ON users FOR UPDATE TO microagent_app
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant() AND role IN ('owner', 'admin', 'manager', 'viewer'));
CREATE POLICY users_platform_select ON users FOR SELECT TO microagent_platform USING (true);

-- ───────────── invitations (token_hash is never readable) ─────────────
GRANT SELECT (id, tenant_id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at)
  ON invitations TO microagent_app;
GRANT INSERT (tenant_id, email, role, token_hash, invited_by, expires_at) ON invitations TO microagent_app;
GRANT UPDATE (revoked_at) ON invitations TO microagent_app;
CREATE POLICY invitations_app_select ON invitations FOR SELECT TO microagent_app
  USING (tenant_id = app_current_tenant());
CREATE POLICY invitations_app_insert ON invitations FOR INSERT TO microagent_app
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY invitations_app_update ON invitations FOR UPDATE TO microagent_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ───────────── ai_employees ─────────────
GRANT SELECT, INSERT, DELETE ON ai_employees TO microagent_app;
GRANT UPDATE (name, job_title, description, status) ON ai_employees TO microagent_app;
CREATE POLICY ai_employees_app_all ON ai_employees FOR ALL TO microagent_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT ON ai_employees TO microagent_platform;
CREATE POLICY ai_employees_platform_select ON ai_employees FOR SELECT TO microagent_platform USING (true);

-- ───────────── usage_daily ─────────────
GRANT SELECT, INSERT ON usage_daily TO microagent_app;
GRANT UPDATE (quantity) ON usage_daily TO microagent_app;
CREATE POLICY usage_app_all ON usage_daily FOR ALL TO microagent_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT ON usage_daily TO microagent_platform;
CREATE POLICY usage_platform_select ON usage_daily FOR SELECT TO microagent_platform USING (true);

-- ───────────── audit_logs (append-only: no UPDATE/DELETE for anyone but the owner) ─────────────
GRANT SELECT, INSERT ON audit_logs TO microagent_app, microagent_platform;
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO microagent_app, microagent_platform;
CREATE POLICY audit_app_select ON audit_logs FOR SELECT TO microagent_app
  USING (tenant_id = app_current_tenant());
CREATE POLICY audit_app_insert ON audit_logs FOR INSERT TO microagent_app
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY audit_platform_select ON audit_logs FOR SELECT TO microagent_platform USING (true);
CREATE POLICY audit_platform_insert ON audit_logs FOR INSERT TO microagent_platform WITH CHECK (true);

-- ───────────── email_outbox: insert-only, no read-back ─────────────
GRANT INSERT ON email_outbox TO microagent_app;
GRANT USAGE ON SEQUENCE email_outbox_id_seq TO microagent_app;

-- sessions, password_reset_tokens, schema_migrations: no grants at all.
-- They are reachable only through the SECURITY DEFINER functions in 0003.
