/**
 * Creates (or resets the password of) a Platform Admin.
 * Platform admins cannot sign up through the public form; this is the only way to create one.
 *
 *   npm run admin:create -- admin@example.com "Full Name"
 *   (password is read from the ADMIN_PASSWORD env var, or prompted if running in a terminal)
 */
import { createInterface } from 'node:readline/promises';
import pg from 'pg';
import { loadConfig } from '../src/config/env.js';
import { hashPassword } from '../src/shared/security.js';

const [email, fullName = 'Platform Admin'] = process.argv.slice(2);
if (!email || !email.includes('@')) {
  console.error('Usage: ADMIN_PASSWORD=... npm run admin:create -- <email> [full name]');
  process.exit(1);
}

let password = process.env.ADMIN_PASSWORD;
if (!password && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Password (min 12 chars): ');
  rl.close();
}
if (!password || password.length < 12) {
  console.error('A password of at least 12 characters is required (set ADMIN_PASSWORD).');
  process.exit(1);
}

const config = loadConfig();
const client = new pg.Client({ connectionString: config.db.owner });
await client.connect();
try {
  const hash = await hashPassword(password);
  const { rows } = await client.query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
     VALUES (NULL, $1, $2, $3, 'platform_admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'
       WHERE users.role = 'platform_admin'
     RETURNING id`,
    [email.trim().toLowerCase(), hash, fullName],
  );
  if (!rows[0]) {
    console.error('That email already belongs to a business account, not a platform admin. Use a different email.');
    process.exit(1);
  }
  console.log(`Platform admin ready: ${email}`);
} finally {
  await client.end();
}
