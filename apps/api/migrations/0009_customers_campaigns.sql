-- 0009: Part 4 — customers (on top of per-channel contacts), consent, tags, activity, campaigns and their sending queue.
-- A "customer" IS a contact of ONE channel. Identities of different platforms are never merged automatically.

ALTER TABLE contacts
  ADD COLUMN email              text CHECK (email IS NULL OR char_length(email) <= 254),
  ADD COLUMN status             text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'lead', 'customer', 'inactive')),
  ADD COLUMN consent_status     text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown', 'opted_in', 'opted_out')),
  ADD COLUMN consent_source     text,
  ADD COLUMN consent_at         timestamptz,
  ADD COLUMN consent_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN notes              text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  ADD COLUMN tags               text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 30),
  ADD COLUMN interests          text[] NOT NULL DEFAULT '{}' CHECK (cardinality(interests) <= 30),
  ADD COLUMN last_inbound_at    timestamptz,
  ADD COLUMN unreachable_at     timestamptz,
  ADD COLUMN unreachable_reason text;
UPDATE contacts ct SET last_inbound_at = cv.last_inbound_at FROM conversations cv WHERE cv.contact_id = ct.id;
CREATE INDEX contacts_tags_idx ON contacts USING gin (tags);
CREATE INDEX contacts_audience_idx ON contacts (tenant_id, channel_id, last_inbound_at DESC);
GRANT UPDATE (email, status, consent_status, consent_source, consent_at, consent_by, notes, tags, interests, last_inbound_at, unreachable_at, unreachable_reason) ON contacts TO microagent_app;

-- Everything that happens to a customer (never invented: only things this system did or saw).
CREATE TABLE customer_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL,
  contact_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('first_contact', 'details_updated', 'tag_added', 'tag_removed', 'status_changed', 'consent_changed', 'campaign_sent', 'unreachable', 'reachable_again')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, channel_id, contact_id) REFERENCES contacts (tenant_id, channel_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_events_idx ON customer_events (tenant_id, contact_id, created_at DESC);
CREATE INDEX customer_events_kind_idx ON customer_events (tenant_id, kind, created_at DESC);

CREATE TABLE campaign_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1500),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

-- One campaign = one message to one audience on ONE channel (so "once per customer per channel" is structural).
CREATE TABLE campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  channel_id      uuid NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('whatsapp', 'messenger', 'instagram', 'telegram')),
  brief           text CHECK (brief IS NULL OR char_length(brief) <= 4000),        -- what the owner asked for, in their words
  message         text NOT NULL DEFAULT '' CHECK (char_length(message) <= 1500),   -- may contain {{first_name}}
  optout_footer   boolean NOT NULL DEFAULT true,
  audience        jsonb NOT NULL DEFAULT '{}'::jsonb,                               -- validated filter (see audience.ts)
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
  created_by_ai   boolean NOT NULL DEFAULT false,
  ai_notes        jsonb NOT NULL DEFAULT '{}'::jsonb,                               -- suggestions / warnings / questions from the builder
  rate_per_minute integer CHECK (rate_per_minute IS NULL OR rate_per_minute BETWEEN 1 AND 600),
  ack_unofficial  boolean NOT NULL DEFAULT false,
  approved_hash   text,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  approved_eligible integer,
  scheduled_at    timestamptz,
  launched_at     timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,                               -- counts frozen at launch
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, channel_id),
  FOREIGN KEY (tenant_id, channel_id, platform) REFERENCES channels (tenant_id, id, type) ON DELETE CASCADE
);
CREATE INDEX campaigns_idx ON campaigns (tenant_id, created_at DESC);
CREATE INDEX campaigns_work_idx ON campaigns (status, scheduled_at) WHERE status IN ('scheduled', 'running');

CREATE TABLE campaign_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  channel_id  uuid NOT NULL,
  contact_id  uuid NOT NULL,
  status      text NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'retrying', 'failed', 'skipped', 'cancelled', 'excluded')),
  reason      text,                          -- why excluded / skipped / failed (machine code)
  detail      text,
  message_id  uuid,
  rendered    text,
  queued_at   timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id),          -- the same customer can never be in the same campaign twice
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, campaign_id, channel_id) REFERENCES campaigns (tenant_id, id, channel_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, channel_id, contact_id) REFERENCES contacts (tenant_id, channel_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (message_id)
);
CREATE INDEX campaign_recipients_idx ON campaign_recipients (tenant_id, campaign_id, status);
CREATE INDEX campaign_recipients_sent_idx ON campaign_recipients (tenant_id, channel_id, sent_at) WHERE sent_at IS NOT NULL;
-- Belt and braces: at most ONE outbound message per campaign recipient, even if two workers race.
CREATE UNIQUE INDEX messages_campaign_recipient_uq ON messages ((meta ->> 'campaignRecipientId')) WHERE meta ? 'campaignRecipientId' AND direction = 'out';

CREATE TABLE campaign_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  kind        text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX campaign_events_idx ON campaign_events (tenant_id, campaign_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_events', 'campaign_templates', 'campaigns', 'campaign_recipients', 'campaign_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO microagent_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t || '_app_all', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON customer_events TO microagent_app;
GRANT USAGE ON SEQUENCE customer_events_id_seq, campaign_events_id_seq TO microagent_app;
GRANT SELECT, INSERT, DELETE ON campaign_templates TO microagent_app;
GRANT SELECT, INSERT, DELETE ON campaigns TO microagent_app;
GRANT UPDATE (name, message, optout_footer, audience, status, ai_notes, rate_per_minute, ack_unofficial, approved_hash, approved_by, approved_at, approved_eligible, scheduled_at, launched_at, started_at, finished_at, snapshot, brief, updated_at) ON campaigns TO microagent_app;
GRANT SELECT, INSERT ON campaign_recipients TO microagent_app;
GRANT UPDATE (status, reason, detail, message_id, rendered, queued_at, sent_at) ON campaign_recipients TO microagent_app;
GRANT SELECT, INSERT ON campaign_events TO microagent_app;
-- Platform admins get NO access to customers, campaigns or recipients (customer privacy), same as conversations.

-- The campaign engine is a background worker: it only learns IDs here, then enters the tenant before touching data.
CREATE FUNCTION worker_campaigns_due(p_limit integer)
RETURNS TABLE (tenant_id uuid, campaign_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.tenant_id, c.id FROM campaigns c JOIN tenants t ON t.id = c.tenant_id
  WHERE t.status = 'active' AND (c.status = 'running' OR (c.status = 'scheduled' AND c.scheduled_at <= now()))
  ORDER BY c.started_at NULLS FIRST, c.created_at LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION worker_campaigns_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_campaigns_due(integer) TO microagent_app;

-- The campaign builder is a new AI purpose (metered like every other call).
DO $$
DECLARE n text;
BEGIN
  SELECT conname INTO n FROM pg_constraint WHERE conrelid = 'ai_usage'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%agent_reply%';
  EXECUTE format('ALTER TABLE ai_usage DROP CONSTRAINT %I', n);
  ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN ('agent_reply', 'simulation', 'extraction', 'classification', 'campaign_builder'));
END $$;
