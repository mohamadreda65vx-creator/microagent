-- Found by the load test (apps/api/test/load.ts): dashboard queries filter messages by tenant + time range.
CREATE INDEX IF NOT EXISTS messages_tenant_created_idx ON messages (tenant_id, created_at DESC);
