-- 0006_rules_runtime.sql  (Part 2)
-- Teach & Correct rules (versioned), AI usage metering, simulations, and the record of every action an employee proposes.

CREATE TABLE teach_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid,                                   -- NULL = applies to every employee of the company
  instruction text NOT NULL CHECK (char_length(btrim(instruction)) BETWEEN 3 AND 1000),
  category    text NOT NULL CHECK (category IN ('knowledge_update', 'behavior_update', 'workflow_update')),
  effect      jsonb NOT NULL CHECK (jsonb_typeof(effect) = 'object'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version     integer NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES ai_employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX teach_rules_idx ON teach_rules (tenant_id, status, employee_id);
CREATE TRIGGER teach_rules_updated_at BEFORE UPDATE ON teach_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE teach_rule_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id     uuid NOT NULL,
  version     integer NOT NULL,
  instruction text NOT NULL,
  category    text NOT NULL,
  effect      jsonb NOT NULL,
  status      text NOT NULL,
  summary     text NOT NULL DEFAULT '',
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES teach_rules (tenant_id, id) ON DELETE CASCADE
);

-- A knowledge_update rule can own a knowledge item ("the cappuccino costs 60 EGP"): disabling/rolling back the rule retires it.
ALTER TABLE knowledge_items ADD COLUMN rule_id uuid;
ALTER TABLE knowledge_items ADD CONSTRAINT knowledge_items_rule_fk FOREIGN KEY (tenant_id, rule_id) REFERENCES teach_rules (tenant_id, id) ON DELETE SET NULL (rule_id);

-- ───────────── AI usage: every call to the model provider, success or failure ─────────────
CREATE TABLE ai_usage (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id       uuid,
  purpose           text NOT NULL CHECK (purpose IN ('agent_reply', 'simulation', 'extraction', 'classification')),
  model             text NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens      integer NOT NULL DEFAULT 0,
  cost_usd          numeric(14, 6),                      -- NULL when the provider did not report a cost
  cost_source       text NOT NULL DEFAULT 'unknown' CHECK (cost_source IN ('provider', 'unknown')),
  latency_ms        integer NOT NULL DEFAULT 0,
  attempts          integer NOT NULL DEFAULT 1,
  status            text NOT NULL CHECK (status IN ('ok', 'error')),
  error_code        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_tenant_idx ON ai_usage (tenant_id, created_at DESC);

-- ───────────── simulations ─────────────
CREATE TABLE simulation_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('chat', 'suite')),
  fingerprint text NOT NULL,                              -- configuration the run was made against
  passed      boolean,
  results     jsonb NOT NULL DEFAULT '[]'::jsonb,
  transcript  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES ai_employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX simulation_runs_idx ON simulation_runs (tenant_id, employee_id, created_at DESC);

-- ───────────── every action an employee proposes, with the backend's decision ─────────────
CREATE TABLE agent_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL,
  run_id          uuid,
  mode            text NOT NULL CHECK (mode IN ('simulation', 'live')),
  type            text NOT NULL,
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision        text NOT NULL CHECK (decision IN ('allowed', 'denied', 'pending_approval', 'invalid')),
  reasons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_status text CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (approval_status IS NULL OR decision = 'pending_approval'),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES ai_employees (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, run_id) REFERENCES simulation_runs (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_actions_idx ON agent_actions (tenant_id, decision, approval_status, created_at DESC);

-- An approval decision is final: it can be made once.
CREATE FUNCTION agent_actions_final_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approval_status IS DISTINCT FROM 'pending' AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    RAISE EXCEPTION 'approval_already_decided' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_actions_final BEFORE UPDATE ON agent_actions FOR EACH ROW EXECUTE FUNCTION agent_actions_final_decision();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teach_rules', 'teach_rule_versions', 'ai_usage', 'simulation_runs', 'agent_actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO microagent_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t || '_app_all', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE (instruction, category, effect, status, version) ON teach_rules TO microagent_app;
GRANT SELECT, INSERT ON teach_rule_versions TO microagent_app;
GRANT SELECT, INSERT ON ai_usage TO microagent_app;
GRANT USAGE ON SEQUENCE ai_usage_id_seq TO microagent_app;
GRANT SELECT, INSERT ON simulation_runs TO microagent_app;
GRANT SELECT, INSERT ON agent_actions TO microagent_app;
GRANT UPDATE (approval_status, decided_by, decided_at, decision_note) ON agent_actions TO microagent_app;
-- knowledge_items.rule_id is written by the app
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_items TO microagent_app;

-- Platform admins see AI consumption per company (read-only).
GRANT SELECT ON ai_usage TO microagent_platform;
CREATE POLICY ai_usage_platform_select ON ai_usage FOR SELECT TO microagent_platform USING (true);
