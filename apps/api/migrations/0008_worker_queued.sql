-- 0008: the delivery worker also picks up messages that were queued but never sent (e.g. the server stopped right after saving).
CREATE OR REPLACE FUNCTION worker_due_retries(p_limit integer)
RETURNS TABLE (tenant_id uuid, message_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.tenant_id, m.id FROM messages m JOIN tenants t ON t.id = m.tenant_id
  WHERE t.status = 'active' AND m.direction = 'out'
    AND ((m.status = 'retry' AND m.next_attempt_at <= now())
      OR (m.status IN ('queued', 'sending') AND m.created_at < now() - interval '2 minutes' AND m.attempts < 5))
  ORDER BY m.created_at LIMIT p_limit
$$;
