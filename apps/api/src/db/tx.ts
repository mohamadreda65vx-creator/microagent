import type { Client, Pool } from './pool.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function inTransaction<T>(pool: Pool, setup: ((c: Client) => Promise<void>) | null, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (setup) await setup(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken; release below discards it */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a transaction scoped to one tenant.
 *
 * The tenant id is set with `set_config(..., is_local = true)`, so it lives ONLY for this
 * transaction and can never leak to the next request that reuses the pooled connection.
 * PostgreSQL Row Level Security policies read it through app_current_tenant().
 */
export function withTenant<T>(pool: Pool, tenantId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('withTenant: invalid tenant id');
  return inTransaction(
    pool,
    async (c) => {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    },
    fn,
  );
}

/** Transaction with NO tenant context: used for auth_* functions that run before a tenant is known. */
export function withoutTenant<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  return inTransaction(pool, null, fn);
}
