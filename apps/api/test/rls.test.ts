import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { createTestEnv, signupTenant, uniqueEmail, type Tenant, type TestEnv } from './helpers.js';

/**
 * Tenant isolation at the DATABASE level.
 * These tests skip the application entirely and talk to PostgreSQL with the same roles the API
 * uses, to prove isolation holds even if application code had a bug.
 */
describe('row level security (database level, no application code)', () => {
  let env: TestEnv;
  let a: Tenant;
  let b: Tenant;
  let bEmployeeId: string;
  let appPool: pg.Pool;
  let platformPool: pg.Pool;

  /** Run SQL as microagent_app with the given tenant context (or none). */
  async function asApp<T>(tenantId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      if (tenantId) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const r = await fn(c);
      await c.query('ROLLBACK'); // never persist what these probes do
      return r;
    } finally {
      c.release();
    }
  }
  const denied = (re = /permission denied|row-level security/i) => (err: unknown) => {
    assert.match((err as Error).message, re);
    return true;
  };

  before(async () => {
    env = await createTestEnv();
    appPool = new pg.Pool({ connectionString: env.config.db.app, max: 1 });
    platformPool = new pg.Pool({ connectionString: env.config.db.platform, max: 1 });
    a = await signupTenant(env, 'RLS A');
    b = await signupTenant(env, 'RLS B');
    await a.client.post('/ai-employees', { name: 'a1' });
    await a.client.post('/ai-employees', { name: 'a2' });
    bEmployeeId = (await b.client.post('/ai-employees', { name: 'b1' })).body.id;
    await b.client.post('/team/invitations', { email: uniqueEmail('inv'), role: 'viewer' });
  });
  after(async () => {
    await appPool.end();
    await platformPool.end();
    await env.close();
  });

  it('with tenant A set, A sees only A rows in every tenant table', async () => {
    await asApp(a.tenantId, async (c) => {
      assert.equal((await c.query('SELECT count(*)::int n FROM ai_employees')).rows[0].n, 2);
      assert.equal((await c.query('SELECT count(*)::int n FROM ai_employees WHERE tenant_id = $1', [b.tenantId])).rows[0].n, 0);
      assert.equal((await c.query('SELECT count(*)::int n FROM tenants')).rows[0].n, 1);
      assert.equal((await c.query('SELECT count(*)::int n FROM users')).rows[0].n, 1);
      assert.equal((await c.query('SELECT count(*)::int n FROM invitations')).rows[0].n, 0);
      assert.equal((await c.query('SELECT count(*)::int n FROM audit_logs WHERE tenant_id = $1', [b.tenantId])).rows[0].n, 0);
    });
  });

  it('is fail-closed: without a tenant context the app role sees nothing at all', async () => {
    await asApp(null, async (c) => {
      for (const table of ['tenants', 'users', 'ai_employees', 'invitations', 'usage_daily', 'audit_logs']) {
        assert.equal((await c.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, `${table} must be empty without tenant context`);
      }
    });
  });

  it('is fail-closed with a malformed tenant id (error, never "all rows")', async () => {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', 'not-a-uuid', true)");
      await assert.rejects(c.query('SELECT * FROM ai_employees'), /invalid input syntax for type uuid/);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('A cannot UPDATE or DELETE B’s rows even with the exact id', async () => {
    await asApp(a.tenantId, async (c) => {
      assert.equal((await c.query(`UPDATE ai_employees SET name = 'x' WHERE id = $1`, [bEmployeeId])).rowCount, 0);
      assert.equal((await c.query('DELETE FROM ai_employees WHERE id = $1', [bEmployeeId])).rowCount, 0);
      assert.equal((await c.query(`UPDATE tenants SET name = 'pwned' WHERE id = $1`, [b.tenantId])).rowCount, 0);
    });
    const still = await env.owner.query('SELECT name FROM ai_employees WHERE id = $1', [bEmployeeId]);
    assert.equal(still.rows[0].name, 'b1');
  });

  it('A cannot INSERT a row that belongs to B, nor move its own row to B', async () => {
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query(`INSERT INTO ai_employees (tenant_id, name) VALUES ($1, 'injected')`, [b.tenantId]), denied(/row-level security/i));
    });
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query('UPDATE ai_employees SET tenant_id = $1', [b.tenantId]), denied(/permission denied/i));
    });
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query(`INSERT INTO usage_daily (tenant_id, metric, quantity) VALUES ($1, 'api_requests', 999)`, [b.tenantId]), denied(/row-level security/i));
    });
  });

  it('the tenant context is transaction-local and never leaks to the next request on a pooled connection', async () => {
    // appPool has max = 1, so both transactions below are guaranteed to reuse the same connection.
    const c1 = await appPool.connect();
    await c1.query('BEGIN');
    await c1.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
    assert.equal((await c1.query('SELECT count(*)::int n FROM ai_employees')).rows[0].n, 2);
    await c1.query('COMMIT');
    const leaked = (await c1.query(`SELECT current_setting('app.tenant_id', true) AS v`)).rows[0].v;
    assert.ok(leaked === '' || leaked === null, `tenant setting leaked after COMMIT: ${leaked}`);
    assert.equal((await c1.query('SELECT count(*)::int n FROM ai_employees')).rows[0].n, 0, 'after COMMIT the setting is gone');
    c1.release();
  });

  it('the app role cannot read secrets or bypass the auth functions', async () => {
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query('SELECT password_hash FROM users'), denied());
    });
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query('SELECT * FROM sessions'), denied());
    });
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query('SELECT * FROM password_reset_tokens'), denied());
    });
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query('SELECT token_hash FROM invitations'), denied());
    });
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query(`INSERT INTO users (tenant_id, email, password_hash, full_name, role) VALUES ($1, 'x@x.test', 'h', 'x', 'owner')`, [a.tenantId]), denied());
    });
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query(`UPDATE tenants SET status = 'suspended'`), denied());
    });
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query(`UPDATE users SET role = 'platform_admin'`), denied());
    });
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query('DELETE FROM audit_logs'), denied());
    });
    await asApp(a.tenantId, async (c) => {
      await assert.rejects(c.query('SET ROLE microagent_owner'), /permission denied/i);
    });
  });

  it('revoking sessions is limited to the caller’s tenant', async () => {
    await asApp(a.tenantId, async (c) => {
      const bUser = await env.owner.query('SELECT id FROM users WHERE tenant_id = $1', [b.tenantId]);
      const res = await c.query('SELECT auth_revoke_user_sessions($1) AS n', [bUser.rows[0].id]);
      assert.equal(res.rows[0].n, 0);
    });
    assert.equal((await b.client.get('/auth/me')).status, 200, 'B is still logged in');
  });

  it('platform role: reads across tenants but cannot read secrets or write business data', async () => {
    const tenants = await platformPool.query('SELECT count(*)::int n FROM tenants');
    assert.equal(tenants.rows[0].n, 2);
    const employees = await platformPool.query('SELECT count(*)::int n FROM ai_employees');
    assert.equal(employees.rows[0].n, 3);
    await assert.rejects(platformPool.query('SELECT password_hash FROM users'), denied());
    await assert.rejects(platformPool.query('SELECT * FROM sessions'), denied());
    await assert.rejects(platformPool.query(`INSERT INTO ai_employees (tenant_id, name) VALUES ($1, 'x')`, [a.tenantId]), denied());
    await assert.rejects(platformPool.query(`UPDATE users SET role = 'platform_admin'`), denied());
    await assert.rejects(platformPool.query(`DELETE FROM tenants`), denied());
  });

  it('database roles are least-privilege (no superuser, no BYPASSRLS)', async () => {
    const { rows } = await env.owner.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('microagent_app', 'microagent_platform', 'microagent_owner')`,
    );
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.rolsuper, false, `${r.rolname} must not be superuser`);
      assert.equal(r.rolbypassrls, false, `${r.rolname} must not bypass RLS`);
    }
  });

  it('GUARD: every table that has a tenant_id column has RLS enabled and at least one policy', async () => {
    const { rows } = await env.owner.query<{ table: string; rls: boolean; policies: number }>(`
      SELECT c.relname AS "table", c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    const names = rows.map((r) => r.table).sort();
    assert.deepEqual(names, ['agent_actions', 'ai_employee_versions', 'ai_employees', 'ai_usage', 'audit_logs', 'business_questions', 'employee_sources', 'invitations', 'knowledge_items', 'knowledge_sources', 'simulation_runs', 'source_contents', 'teach_rule_versions', 'teach_rules', 'usage_daily', 'users'], 'unexpected set of tenant tables — update this guard together with the new migration');
    // `tenants` itself is keyed by id rather than tenant_id, so it is checked explicitly.
    const t = await env.owner.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'tenants' AND relkind = 'r'`);
    assert.equal(t.rows[0].relrowsecurity, true, 'tenants must have RLS enabled');
    for (const r of rows) {
      assert.equal(r.rls, true, `table "${r.table}" has a tenant_id column but RLS is NOT enabled`);
      assert.ok(r.policies >= 1, `table "${r.table}" has RLS enabled but no policy`);
    }
  });

  it('GUARD: the app and platform roles have no privileges on tables outside the whitelist', async () => {
    const { rows } = await env.owner.query<{ table_name: string; grantee: string }>(`
      SELECT DISTINCT table_name, grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('microagent_app', 'microagent_platform')`);
    const allowed = new Set(['tenants', 'users', 'invitations', 'ai_employees', 'usage_daily', 'audit_logs', 'email_outbox', ...['agent_actions', 'ai_employee_versions', 'ai_usage', 'business_questions', 'employee_sources', 'knowledge_items', 'knowledge_sources', 'simulation_runs', 'source_contents', 'teach_rule_versions', 'teach_rules']]);
    for (const r of rows) assert.ok(allowed.has(r.table_name), `${r.grantee} unexpectedly has privileges on ${r.table_name}`);
    // Secret columns must never be READABLE. (The app may INSERT a token_hash when creating an invitation:
    // write-only is intended, so only SELECT is forbidden here.)
    const cols = await env.owner.query(`
      SELECT table_name, column_name, grantee FROM information_schema.column_privileges
      WHERE table_schema = 'public' AND grantee IN ('microagent_app', 'microagent_platform')
        AND column_name IN ('password_hash', 'token_hash') AND privilege_type = 'SELECT'`);
    assert.equal(cols.rowCount, 0, `secret columns are readable: ${JSON.stringify(cols.rows)}`);
  });
});
