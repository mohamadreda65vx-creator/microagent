import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Minimal, dependency-free migration runner.
 *  - Applies migrations/*.sql in filename order, each inside its own transaction.
 *  - Records name + SHA-256 checksum in schema_migrations.
 *  - Refuses to continue if an already-applied migration file was edited (checksum mismatch).
 * Must run with the OWNER connection string.
 */
export async function runMigrations(ownerUrl: string, log: (msg: string) => void = console.log): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    // Serialize concurrent runners (e.g. two deploys at once).
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();

    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = done.get(file);
      if (existing) {
        if (existing !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead of editing it.`);
        }
        result.skipped.push(file);
        continue;
      }
      log(`applying ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      result.applied.push(file);
    }
    await client.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    await client.end();
  }
  return result;
}

// CLI: `npm run db:migrate`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import('../config/env.js');
  const config = loadConfig();
  runMigrations(config.db.owner)
    .then((r) => {
      console.log(`done. applied: ${r.applied.length}, already up to date: ${r.skipped.length}`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
