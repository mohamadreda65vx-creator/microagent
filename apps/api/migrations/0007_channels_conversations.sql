-- 0007_channels_conversations.sql  (Part 3)
-- Channels (WhatsApp, Messenger, Instagram, Telegram, Website chat), contacts, conversations, messages,
-- delivery state, webhook log (idempotency lives on messages), forwarding.
--
-- Isolation between PLATFORMS is enforced by the database, not only by the API:
--   contacts       belong to ONE channel           (tenant_id, channel_id, id)
--   conversations  carry the channel's platform    FK (tenant_id, channel_id, platform) -> channels(tenant_id, id, type)
--                  and point at a contact of the SAME channel
--   messages       point at a conversation of the SAME channel
-- so a WhatsApp message can never be stored inside a Messenger conversation, even if application code is wrong.

CREATE TABLE channels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type                text NOT NULL CHECK (type IN ('whatsapp', 'messenger', 'instagram', 'telegram', 'website', 'tiktok')),
  provider            text NOT NULL CHECK (provider IN ('evolution', 'whatsapp_cloud', 'telegram_bot', 'meta', 'widget')),
  name                text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connecting', 'connected', 'disconnected', 'error', 'awaiting_approval', 'not_configured')),
  employee_id         uuid,                                   -- the AI employee that answers on this channel
  auto_reply          boolean NOT NULL DEFAULT true,
  public_key          text NOT NULL UNIQUE,                   -- unguessable id used in webhook URLs and the website embed script
  external_account_id text,                                   -- bot id / WhatsApp instance / page id: one account can belong to ONE company only
  credentials_enc     text,                                   -- AES-256-GCM encrypted JSON; never returned by the API
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  health_status       text NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'degraded', 'down', 'unknown')),
  last_health_at      timestamptz,
  last_error          text,
  last_error_at       timestamptz,
  last_inbound_at     timestamptz,
  last_outbound_at    timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, type),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES ai_employees (tenant_id, id) ON DELETE SET NULL (employee_id)
);
CREATE UNIQUE INDEX channels_external_account_uidx ON channels (type, external_account_id) WHERE external_account_id IS NOT NULL;
CREATE INDEX channels_tenant_idx ON channels (tenant_id, type);
CREATE TRIGGER channels_updated_at BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL,
  external_id   text NOT NULL,                                -- chat id / JID / PSID / visitor id (per channel)
  name          text,
  phone         text,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id           uuid NOT NULL,
  platform             text NOT NULL,
  contact_id           uuid NOT NULL,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved')),
  handler              text NOT NULL DEFAULT 'ai' CHECK (handler IN ('ai', 'human')),
  assigned_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  employee_id          uuid,
  unread_count         integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message_at      timestamptz NOT NULL DEFAULT now(),
  last_message_preview text NOT NULL DEFAULT '',
  last_inbound_at      timestamptz,
  handoff_reason       text,
  handoff_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, contact_id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_id, id),
  FOREIGN KEY (tenant_id, channel_id, platform) REFERENCES channels (tenant_id, id, type) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, channel_id, contact_id) REFERENCES contacts (tenant_id, channel_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES ai_employees (tenant_id, id) ON DELETE SET NULL (employee_id)
);
CREATE INDEX conversations_list_idx ON conversations (tenant_id, platform, last_message_at DESC);
CREATE INDEX conversations_unread_idx ON conversations (tenant_id, platform) WHERE unread_count > 0;
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL,
  conversation_id uuid NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  sender_type     text NOT NULL CHECK (sender_type IN ('customer', 'ai', 'human', 'system')),
  sender_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  external_id     text,                                       -- provider message id: unique per channel => webhook replays cannot duplicate
  body            text NOT NULL DEFAULT '' CHECK (char_length(body) <= 8000),
  attachments     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL CHECK (status IN ('received', 'queued', 'sending', 'retry', 'sent', 'delivered', 'read', 'failed')),
  error_code      text,
  error           text,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  ai_state        text CHECK (ai_state IN ('pending', 'done', 'skipped')),
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id, conversation_id) REFERENCES conversations (tenant_id, channel_id, id) ON DELETE CASCADE,
  CHECK (direction = 'in' OR ai_state IS NULL)
);
CREATE UNIQUE INDEX messages_external_uidx ON messages (channel_id, direction, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX messages_conv_idx ON messages (conversation_id, created_at, id);
CREATE INDEX messages_retry_idx ON messages (next_attempt_at) WHERE status = 'retry';
CREATE INDEX messages_ai_pending_idx ON messages (created_at) WHERE ai_state = 'pending';

CREATE TABLE message_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL,
  conversation_id uuid NOT NULL,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  mime            text NOT NULL,
  size            integer NOT NULL CHECK (size BETWEEN 1 AND 5242880),
  data            bytea NOT NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id, conversation_id) REFERENCES conversations (tenant_id, channel_id, id) ON DELETE CASCADE
);

CREATE TABLE webhook_events (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  kind       text NOT NULL,
  status     text NOT NULL CHECK (status IN ('processed', 'duplicate', 'ignored', 'rejected', 'error')),
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX webhook_events_idx ON webhook_events (channel_id, created_at DESC);

CREATE TABLE message_forwards (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_message_id  uuid NOT NULL,
  source_channel_id  uuid NOT NULL,
  target_channel_id  uuid NOT NULL,
  target_contact_id  uuid NOT NULL,
  mode               text NOT NULL DEFAULT 'new_message' CHECK (mode IN ('new_message')),
  comment            text,
  sent_text          text NOT NULL,
  status             text NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
  result_message_id  uuid,
  error              text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_channel_id) REFERENCES channels (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, target_channel_id) REFERENCES channels (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, target_channel_id, target_contact_id) REFERENCES contacts (tenant_id, channel_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, result_message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (result_message_id),
  CHECK (source_channel_id <> target_channel_id)
);
CREATE INDEX message_forwards_idx ON message_forwards (tenant_id, created_at DESC);

-- Live actions point at the conversation they came from.
ALTER TABLE agent_actions ADD COLUMN conversation_id uuid;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_conversation_fk FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (conversation_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channels', 'contacts', 'conversations', 'messages', 'message_files', 'webhook_events', 'message_forwards'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO microagent_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t || '_app_all', t);
  END LOOP;
END $$;

-- What the application may write. Identity columns (tenant_id, type, provider, public_key, channel_id...) are immutable.
GRANT SELECT, INSERT, DELETE ON channels TO microagent_app;
GRANT UPDATE (name, status, employee_id, auto_reply, external_account_id, credentials_enc, config, health_status, last_health_at, last_error, last_error_at, last_inbound_at, last_outbound_at, consecutive_failures) ON channels TO microagent_app;
GRANT SELECT, INSERT ON contacts TO microagent_app;
GRANT UPDATE (name, phone, meta, last_seen_at) ON contacts TO microagent_app;
GRANT SELECT, INSERT ON conversations TO microagent_app;
GRANT UPDATE (status, handler, assigned_user_id, employee_id, unread_count, last_message_at, last_message_preview, last_inbound_at, handoff_reason, handoff_at) ON conversations TO microagent_app;
GRANT SELECT, INSERT ON messages TO microagent_app;
GRANT UPDATE (external_id, status, error_code, error, attempts, next_attempt_at, ai_state, meta, sent_at, attachments) ON messages TO microagent_app;
GRANT SELECT, INSERT ON message_files TO microagent_app;
GRANT SELECT, INSERT, DELETE ON webhook_events TO microagent_app;
GRANT USAGE ON SEQUENCE webhook_events_id_seq TO microagent_app;
GRANT SELECT, INSERT ON message_forwards TO microagent_app;
GRANT UPDATE (status, result_message_id, error) ON message_forwards TO microagent_app;
-- Platform admins deliberately get NO access to channels, contacts, conversations or messages (customer privacy).

-- ───────────── pre-tenant lookups (webhooks arrive before a tenant is known) ─────────────
CREATE FUNCTION channel_resolve(p_public_key text)
RETURNS TABLE (tenant_id uuid, channel_id uuid, type text, provider text, status text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.tenant_id, c.id, c.type, c.provider, c.status, t.status
  FROM channels c JOIN tenants t ON t.id = c.tenant_id WHERE c.public_key = p_public_key
$$;

CREATE FUNCTION channel_resolve_external(p_type text, p_external text)
RETURNS TABLE (tenant_id uuid, channel_id uuid, type text, provider text, status text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.tenant_id, c.id, c.type, c.provider, c.status, t.status
  FROM channels c JOIN tenants t ON t.id = c.tenant_id WHERE c.type = p_type AND c.external_account_id = p_external
$$;

-- Background workers: they only receive IDs, then switch into the tenant before touching any data.
CREATE FUNCTION worker_due_retries(p_limit integer)
RETURNS TABLE (tenant_id uuid, message_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.tenant_id, m.id FROM messages m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.status = 'retry' AND m.next_attempt_at <= now() AND t.status = 'active'
  ORDER BY m.next_attempt_at LIMIT p_limit
$$;

CREATE FUNCTION worker_pending_ai(p_limit integer, p_older_than_seconds integer)
RETURNS TABLE (tenant_id uuid, conversation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT m.tenant_id, m.conversation_id FROM messages m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.ai_state = 'pending' AND m.created_at < now() - make_interval(secs => p_older_than_seconds) AND t.status = 'active'
  LIMIT p_limit
$$;

CREATE FUNCTION worker_health_due(p_limit integer, p_interval_seconds integer)
RETURNS TABLE (tenant_id uuid, channel_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.tenant_id, c.id FROM channels c JOIN tenants t ON t.id = c.tenant_id
  WHERE c.status IN ('connected', 'connecting', 'error', 'awaiting_approval') AND c.type <> 'website' AND t.status = 'active'
    AND (c.last_health_at IS NULL OR c.last_health_at < now() - make_interval(secs => p_interval_seconds))
  ORDER BY c.last_health_at NULLS FIRST LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION channel_resolve(text), channel_resolve_external(text, text), worker_due_retries(integer), worker_pending_ai(integer, integer), worker_health_due(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_resolve(text), channel_resolve_external(text, text), worker_due_retries(integer), worker_pending_ai(integer, integer), worker_health_due(integer, integer) TO microagent_app;
