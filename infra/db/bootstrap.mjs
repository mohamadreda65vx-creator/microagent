#!/usr/bin/env node
/**
 * MicroAgent — database bootstrap for MANAGED PostgreSQL (Railway, etc.) where you cannot run psql as the postgres OS user.
 * Same result as infra/db/setup.sh: three login roles (owner / app / platform), the database owned by the owner role, citext, grants.
 *
 *   ADMIN_DATABASE_URL=postgres://postgres:***@host:port/railway  OWNER_PW=... APP_PW=... PLATFORM_PW=...  node infra/db/bootstrap.mjs
 *
 * ADMIN_DATABASE_URL must be a SUPERUSER connection to the database you want to use (its name is taken from the URL).
 * Run it once from your own computer. Idempotent: running it again only resets the three passwords.
 * Roles are per PostgreSQL server: do not run this on a server shared with other apps that use roles with these names.
 */
import pg from 'pg';

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} is required`); process.exit(1); } return v; };
const adminUrl = need('ADMIN_DATABASE_URL');
const pw = { owner: need('OWNER_PW'), app: need('APP_PW'), platform: need('PLATFORM_PW') };
for (const [k, v] of Object.entries(pw)) if (v.length < 16 || /['"\\\s@:/?#]/.test(v)) { console.error(`${k}_PW must be 16+ characters of letters/digits only (it goes into a URL). Try: openssl rand -hex 16`); process.exit(1); }
const dbName = decodeURIComponent(new URL(adminUrl).pathname.slice(1));
if (!/^[A-Za-z0-9_]+$/.test(dbName)) { console.error('database name in the URL must be letters, digits or _'); process.exit(1); }

const c = new pg.Client({ connectionString: adminUrl, ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined });
await c.connect();
const su = (await c.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0]?.rolsuper;
if (!su) { console.error('This connection is not a superuser; cannot create roles. Use the admin/postgres credentials of the database.'); process.exit(1); }

for (const role of ['owner', 'app', 'platform']) {
  const name = `microagent_${role}`;
  const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount > 0;
  const { rows } = await c.query(`SELECT format('%s ROLE ${name} LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', $1::text, $2::text) AS sql`, [exists ? 'ALTER' : 'CREATE', pw[role]]);
  await c.query(rows[0].sql);
}
await c.query(`ALTER DATABASE ${dbName} OWNER TO microagent_owner`);
await c.query('CREATE EXTENSION IF NOT EXISTS citext');
await c.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
await c.query(`GRANT CONNECT ON DATABASE ${dbName} TO microagent_owner, microagent_app, microagent_platform`);
await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
await c.query('ALTER SCHEMA public OWNER TO microagent_owner');
await c.query('GRANT USAGE ON SCHEMA public TO microagent_app, microagent_platform');
await c.end();
console.log(`database ready: ${dbName} (roles microagent_owner / microagent_app / microagent_platform)`);
