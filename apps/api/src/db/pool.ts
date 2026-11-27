import pg from 'pg';
import type { Config } from '../config/env.js';

// Return timestamps as ISO strings and bigint counts as numbers (our counts stay far below 2^53).
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export interface Pools {
  /** microagent_app — RLS enforced. Used for every request that belongs to a tenant. */
  app: Pool;
  /** microagent_platform — used only by the Platform Admin module. */
  platform: Pool;
  close(): Promise<void>;
}

export function createPools(config: Config): Pools {
  const app = new pg.Pool({ connectionString: config.db.app, max: Number(process.env.DB_POOL_MAX) || 10, application_name: 'microagent-app' });
  const platform = new pg.Pool({ connectionString: config.db.platform, max: 4, application_name: 'microagent-platform' });
  for (const p of [app, platform]) p.on('error', (err) => console.error('[pg pool error]', err.message));
  return {
    app,
    platform,
    async close() {
      await Promise.all([app.end(), platform.end()]);
    },
  };
}
