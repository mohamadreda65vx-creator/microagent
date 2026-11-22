-- 0004_employees_v2.sql  (Part 2)
-- Full AI Employee profile + version history. Tenant isolation: RLS + composite (tenant_id, id) foreign keys,
-- so a child row can never reference a parent that belongs to a different tenant, even if application code is wrong.

ALTER TABLE ai_employees
  ADD COLUMN avatar          text    NOT NULL DEFAULT 'bot-1' CHECK (avatar ~ '^[a-z]+-[0-9]{1,2}$'),
  ADD COLUMN personality     text    NOT NULL DEFAULT '' CHECK (char_length(personality) <= 2000),
  ADD COLUMN language        text    NOT NULL DEFAULT 'auto' CHECK (language IN ('auto', 'ar', 'en')),
  ADD COLUMN dialect         text    NOT NULL DEFAULT 'none' CHECK (dialect IN ('none', 'egyptian', 'gulf', 'levantine', 'maghrebi', 'msa')),
  ADD COLUMN tasks           text[]  NOT NULL DEFAULT '{}' CHECK (tasks <@ ARRAY['customer_support', 'lead_collection', 'sales_assistant', 'follow_up', 'booking', 'order_assistance', 'faq', 'human_handoff']::text[]),
  ADD COLUMN knowledge_mode  text    NOT NULL DEFAULT 'all' CHECK (knowledge_mode IN ('all', 'selected')),
  ADD COLUMN permissions     jsonb   NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permissions) = 'object'),
  ADD COLUMN channels        text[]  NOT NULL DEFAULT '{}' CHECK (channels <@ ARRAY['whatsapp', 'messenger', 'instagram', 'website_chat']::text[]),
  ADD COLUMN model           text    CHECK (model IS NULL OR char_length(model) BETWEEN 3 AND 100),
  ADD COLUMN version         integer NOT NULL DEFAULT 1,
  ADD COLUMN tested_fingerprint text,
  ADD COLUMN tested_at       timestamptz;

-- Part 1 allowed activating an employee with no job at all. From now on an active employee needs at least one task.
UPDATE ai_employees SET status = 'draft' WHERE status = 'active';
ALTER TABLE ai_employees ADD CONSTRAINT ai_employees_active_needs_task CHECK (status <> 'active' OR cardinality(tasks) > 0);
ALTER TABLE ai_employees ADD CONSTRAINT ai_employees_tenant_id_unique UNIQUE (tenant_id, id);

GRANT UPDATE (avatar, personality, language, dialect, tasks, knowledge_mode, permissions, channels, model, version, tested_fingerprint, tested_at)
  ON ai_employees TO microagent_app;

-- Tenant-level AI budget (NULL = platform default from AI_MONTHLY_TOKEN_LIMIT). Changed only by platform admins.
ALTER TABLE tenants ADD COLUMN ai_monthly_token_limit bigint CHECK (ai_monthly_token_limit IS NULL OR ai_monthly_token_limit >= 0);
GRANT SELECT (ai_monthly_token_limit) ON tenants TO microagent_app, microagent_platform;
GRANT UPDATE (ai_monthly_token_limit) ON tenants TO microagent_platform;

-- ───────────── version history of the employee configuration ─────────────
CREATE TABLE ai_employee_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  version     integer NOT NULL,
  snapshot    jsonb NOT NULL,
  summary     text NOT NULL DEFAULT '',
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, version),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES ai_employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_employee_versions_idx ON ai_employee_versions (tenant_id, employee_id, version DESC);

ALTER TABLE ai_employee_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_employee_versions_app_all ON ai_employee_versions FOR ALL TO microagent_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT ON ai_employee_versions TO microagent_app;   -- history is append-only
