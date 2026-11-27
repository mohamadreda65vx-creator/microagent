-- Found by the security review / RLS guard: system_errors has a tenant_id column but no RLS, so a tenant-role connection could
-- insert error rows attributed to ANOTHER company. Fix: RLS on; the tenant role may only insert rows for its own tenant (or none);
-- the API's global error handler now writes through the platform role, which can insert and read everything.
ALTER TABLE system_errors ENABLE ROW LEVEL SECURITY;
CREATE POLICY system_errors_app_insert ON system_errors FOR INSERT TO microagent_app
  WITH CHECK (tenant_id IS NULL OR tenant_id = app_current_tenant());
CREATE POLICY system_errors_platform_all ON system_errors FOR ALL TO microagent_platform USING (true) WITH CHECK (true);
