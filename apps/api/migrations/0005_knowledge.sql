-- 0005_knowledge.sql  (Part 2)
-- Business Discovery: sources → extracted contents → knowledge items (with evidence, date, confirmation status) → smart questions.

CREATE TABLE knowledge_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('website', 'social', 'document', 'product_list', 'business_info')),
  name             text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  config           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  post_limit       integer NOT NULL DEFAULT 30 CHECK (post_limit BETWEEN 1 AND 200),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'analyzing', 'analyzed', 'failed')),
  last_analyzed_at timestamptz,
  last_error       text,
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX knowledge_sources_tenant_idx ON knowledge_sources (tenant_id, created_at DESC);
CREATE TRIGGER knowledge_sources_updated_at BEFORE UPDATE ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Raw text pulled from a source (a web page, a post, a document, a sheet). Kept so analysis can be repeated
-- and so every extracted fact can be checked against its evidence.
CREATE TABLE source_contents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id    uuid NOT NULL,
  ref          text NOT NULL CHECK (char_length(ref) <= 1000),
  title        text NOT NULL DEFAULT '' CHECK (char_length(title) <= 500),
  content      text NOT NULL CHECK (char_length(content) <= 300000),
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  UNIQUE (source_id, ref),
  FOREIGN KEY (tenant_id, source_id) REFERENCES knowledge_sources (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX source_contents_source_idx ON source_contents (tenant_id, source_id, published_at DESC NULLS LAST);

CREATE TABLE knowledge_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id    uuid,
  kind         text NOT NULL CHECK (kind IN ('product', 'service', 'offer', 'faq', 'business_info', 'audience')),
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 300),
  norm_key     text NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  evidence     text NOT NULL DEFAULT '' CHECK (char_length(evidence) <= 2000),
  source_ref   text NOT NULL DEFAULT '' CHECK (char_length(source_ref) <= 1000),
  source_date  timestamptz,                      -- the date of the information itself (post date, page fetch date, owner entry)
  origin       text NOT NULL CHECK (origin IN ('extracted', 'owner')),
  status       text NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'confirmed', 'rejected', 'outdated')),
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES knowledge_sources (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_items_tenant_idx ON knowledge_items (tenant_id, kind, status);
CREATE INDEX knowledge_items_norm_idx ON knowledge_items (tenant_id, norm_key);
CREATE TRIGGER knowledge_items_updated_at BEFORE UPDATE ON knowledge_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Questions we ask the business owner. subject_key is unique per tenant: the same question is never created twice,
-- and an answered or dismissed question is never asked again.
CREATE TABLE business_questions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('missing', 'conflict', 'outdated')),
  subject_key      text NOT NULL,
  question         text NOT NULL,
  options          jsonb NOT NULL DEFAULT '{}'::jsonb,
  related_item_ids uuid[] NOT NULL DEFAULT '{}',
  priority         integer NOT NULL DEFAULT 50,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dismissed')),
  answer           jsonb,
  answered_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  answered_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_key),
  UNIQUE (tenant_id, id)
);
CREATE INDEX business_questions_open_idx ON business_questions (tenant_id, status, priority DESC);

-- Which sources an employee may use when its knowledge_mode = 'selected'.
CREATE TABLE employee_sources (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  source_id   uuid NOT NULL,
  PRIMARY KEY (employee_id, source_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES ai_employees (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_id) REFERENCES knowledge_sources (tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_sources', 'source_contents', 'knowledge_items', 'business_questions', 'employee_sources'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO microagent_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t || '_app_all', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_sources, source_contents, knowledge_items, business_questions, employee_sources TO microagent_app;
