-- 0010: Workflows (versioned graphs, runs, step logs, human tasks), in-app notifications,
--       subscription/limits columns, system error log, and aggregate-only functions for the Super Admin dashboard.

-- ───────────── workflows ─────────────
CREATE TABLE workflows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  active_version_id uuid,
  latest_version    integer NOT NULL DEFAULT 0,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (status <> 'active' OR active_version_id IS NOT NULL)
);
CREATE INDEX workflows_tenant_idx ON workflows (tenant_id, updated_at DESC);
CREATE TRIGGER workflows_updated_at BEFORE UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Versions are immutable: the app role can INSERT and SELECT, never UPDATE or DELETE.
CREATE TABLE workflow_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL,
  version     integer NOT NULL CHECK (version >= 1),
  graph       jsonb NOT NULL,
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE workflows ADD CONSTRAINT workflows_active_version_fk FOREIGN KEY (tenant_id, active_version_id) REFERENCES workflow_versions (tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE workflow_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id   uuid NOT NULL,
  version_id    uuid NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('test', 'live')),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  trigger_kind  text NOT NULL,
  trigger       jsonb NOT NULL DEFAULT '{}'::jsonb,
  context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_node  text,
  wait_kind     text CHECK (wait_kind IN ('delay', 'task', 'child')),
  resume_at     timestamptz,
  parent_run_id uuid,
  parent_node_id text,
  depth         integer NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 3),
  dedupe_key    text,
  step_count    integer NOT NULL DEFAULT 0,
  error         text,
  locked_at     timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, version_id) REFERENCES workflow_versions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parent_run_id) REFERENCES workflow_runs (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX workflow_runs_wf_idx ON workflow_runs (tenant_id, workflow_id, created_at DESC);
CREATE INDEX workflow_runs_due_idx ON workflow_runs (status, resume_at) WHERE status IN ('queued', 'waiting', 'running');
-- The same trigger event can never start the same workflow twice (webhook replays, retries).
CREATE UNIQUE INDEX workflow_runs_dedupe_uidx ON workflow_runs (workflow_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE workflow_steps (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id      uuid NOT NULL,
  seq         integer NOT NULL,
  node_id     text NOT NULL,
  node_type   text NOT NULL,
  status      text NOT NULL CHECK (status IN ('ok', 'error', 'skipped', 'waiting')),
  dry_run     boolean NOT NULL DEFAULT false,
  input       jsonb NOT NULL DEFAULT '{}'::jsonb,
  output      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (run_id, seq),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE workflow_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL,
  node_id      text NOT NULL,
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 2000),
  assignee_role text NOT NULL DEFAULT 'manager' CHECK (assignee_role IN ('owner', 'admin', 'manager')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'expired', 'cancelled')),
  outcome      text CHECK (outcome IN ('approved', 'rejected')),
  note         text CHECK (note IS NULL OR char_length(note) <= 1000),
  due_at       timestamptz,
  completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (run_id, node_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX workflow_tasks_open_idx ON workflow_tasks (tenant_id, status, created_at DESC);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body       text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  link       text,
  source     text NOT NULL DEFAULT 'workflow',
  run_id     uuid,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Idempotency for workflow side effects: a step re-run after a crash cannot message the customer twice.
CREATE UNIQUE INDEX messages_workflow_step_uq ON messages ((meta->>'workflowStepKey')) WHERE meta ? 'workflowStepKey';

-- ───────────── subscription & limits (managed by hand by the platform admin; no payment processor is connected) ─────────────
ALTER TABLE tenants
  ADD COLUMN subscription_status text NOT NULL DEFAULT 'trialing' CHECK (subscription_status IN ('trialing', 'active', 'past_due', 'cancelled')),
  ADD COLUMN trial_ends_at timestamptz,
  ADD COLUMN plan_changed_at timestamptz,
  ADD COLUMN limits jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE tenants SET trial_ends_at = created_at + interval '14 days' WHERE plan = 'trial';
GRANT SELECT (subscription_status, trial_ends_at, plan_changed_at, limits) ON tenants TO microagent_app, microagent_platform;
GRANT UPDATE (subscription_status, trial_ends_at, plan_changed_at, limits) ON tenants TO microagent_platform;

-- ───────────── system error log (code + short message only; no payloads, no secrets) ─────────────
CREATE TABLE system_errors (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid REFERENCES tenants(id) ON DELETE SET NULL,
  source     text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 40),
  code       text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 80),
  message    text NOT NULL DEFAULT '' CHECK (char_length(message) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_errors_idx ON system_errors (created_at DESC);

-- ───────────── RLS + grants ─────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflows', 'workflow_versions', 'workflow_runs', 'workflow_steps', 'workflow_tasks', 'notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO microagent_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t || '_app_all', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON workflows TO microagent_app;
GRANT UPDATE (name, description, status, active_version_id, latest_version, updated_at) ON workflows TO microagent_app;
GRANT SELECT, INSERT ON workflow_versions TO microagent_app;
GRANT SELECT, INSERT ON workflow_runs TO microagent_app;
GRANT UPDATE (status, context, current_node, wait_kind, resume_at, step_count, error, locked_at, started_at, finished_at) ON workflow_runs TO microagent_app;
GRANT SELECT, INSERT ON workflow_steps TO microagent_app;
GRANT UPDATE (status, output, error, finished_at) ON workflow_steps TO microagent_app;
GRANT USAGE ON SEQUENCE workflow_steps_id_seq TO microagent_app;
GRANT SELECT, INSERT ON workflow_tasks TO microagent_app;
GRANT UPDATE (status, outcome, note, completed_by, completed_at) ON workflow_tasks TO microagent_app;
GRANT SELECT, INSERT ON notifications TO microagent_app;
GRANT UPDATE (read_at) ON notifications TO microagent_app;
GRANT INSERT ON system_errors TO microagent_app, microagent_platform;
GRANT SELECT ON system_errors TO microagent_platform;
GRANT USAGE ON SEQUENCE system_errors_id_seq TO microagent_app, microagent_platform;
-- Platform admins have NO direct access to workflow data or notifications (company content).

-- ───────────── worker: runs that need attention (IDs only) ─────────────
CREATE FUNCTION worker_workflows_due(p_limit integer)
RETURNS TABLE (tenant_id uuid, run_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.tenant_id, r.id FROM workflow_runs r JOIN tenants t ON t.id = r.tenant_id
  WHERE t.status = 'active' AND (
       r.status = 'queued'
    OR (r.status = 'waiting' AND r.wait_kind = 'delay' AND r.resume_at <= now())
    OR (r.status = 'waiting' AND r.wait_kind = 'task' AND r.resume_at IS NOT NULL AND r.resume_at <= now())
    OR (r.status = 'running' AND r.locked_at < now() - interval '5 minutes'))
  ORDER BY r.created_at LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION worker_workflows_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_workflows_due(integer) TO microagent_app;

-- ───────────── Super Admin: aggregates only (never message text, customer data or credentials) ─────────────
CREATE FUNCTION platform_channel_stats() RETURNS TABLE (type text, status text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT type, status, count(*) FROM channels GROUP BY 1, 2 $$;
CREATE FUNCTION platform_message_volume(p_days integer) RETURNS TABLE (day date, inbound bigint, ai_out bigint, human_out bigint, system_out bigint, failed bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (created_at AT TIME ZONE 'utc')::date, count(*) FILTER (WHERE direction = 'in'), count(*) FILTER (WHERE direction = 'out' AND sender_type = 'ai'),
         count(*) FILTER (WHERE direction = 'out' AND sender_type = 'human'), count(*) FILTER (WHERE direction = 'out' AND sender_type = 'system'), count(*) FILTER (WHERE status = 'failed')
  FROM messages WHERE created_at >= (now() AT TIME ZONE 'utc')::date - (LEAST(GREATEST(p_days, 1), 90) - 1) GROUP BY 1 ORDER BY 1
$$;
CREATE FUNCTION platform_tenant_counts() RETURNS TABLE (tenant_id uuid, channels bigint, connected_channels bigint, messages_month bigint, campaigns_month bigint, workflow_runs_month bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id,
    (SELECT count(*) FROM channels c WHERE c.tenant_id = t.id),
    (SELECT count(*) FROM channels c WHERE c.tenant_id = t.id AND c.status = 'connected'),
    (SELECT count(*) FROM messages m WHERE m.tenant_id = t.id AND m.created_at >= date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'),
    (SELECT count(*) FROM campaigns c WHERE c.tenant_id = t.id AND c.created_at >= date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'),
    (SELECT count(*) FROM workflow_runs w WHERE w.tenant_id = t.id AND w.mode = 'live' AND w.created_at >= date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')
  FROM tenants t
$$;
CREATE FUNCTION platform_failure_counts() RETURNS TABLE (failed_messages_24h bigint, failed_campaign_messages_24h bigint, failed_workflow_runs_24h bigint, channel_errors bigint, webhook_errors_24h bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*) FROM messages WHERE status = 'failed' AND created_at >= now() - interval '24 hours'),
         (SELECT count(*) FROM campaign_recipients WHERE status = 'failed' AND queued_at >= now() - interval '24 hours'),
         (SELECT count(*) FROM workflow_runs WHERE status = 'failed' AND mode = 'live' AND created_at >= now() - interval '24 hours'),
         (SELECT count(*) FROM channels WHERE status IN ('error', 'disconnected') AND last_error IS NOT NULL),
         (SELECT count(*) FROM webhook_events WHERE status IN ('rejected', 'error') AND created_at >= now() - interval '24 hours')
$$;
REVOKE ALL ON FUNCTION platform_channel_stats(), platform_message_volume(integer), platform_tenant_counts(), platform_failure_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_channel_stats(), platform_message_volume(integer), platform_tenant_counts(), platform_failure_counts() TO microagent_platform;

-- Metered AI purpose for workflow AI nodes.
DO $$
DECLARE n text;
BEGIN
  SELECT conname INTO n FROM pg_constraint WHERE conrelid = 'ai_usage'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%agent_reply%';
  EXECUTE format('ALTER TABLE ai_usage DROP CONSTRAINT %I', n);
  ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN ('agent_reply', 'simulation', 'extraction', 'classification', 'campaign_builder', 'workflow'));
END $$;
