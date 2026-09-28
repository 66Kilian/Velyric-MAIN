import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import type { ProvidedDatabase } from './provided.js';

export interface TestDatabase {
  readonly name: string;
  readonly info: ProvidedDatabase;
  readonly connectionString: string;
  readonly admin: pg.Pool;
  pool(
    role: 'velyric_app' | 'velyric_metering' | 'velyric_support' | 'velyric_readonly',
    max?: number,
  ): pg.Pool;
}

function url(info: ProvidedDatabase, database: string): string {
  return `postgres://${encodeURIComponent(info.user)}:${encodeURIComponent(info.password)}@${info.host}:${String(info.port)}/${database}`;
}

export function useMigratedDatabase(): () => TestDatabase {
  let database: TestDatabase | undefined;
  const pools: pg.Pool[] = [];

  beforeAll(async () => {
    const info = inject('velyricDb');
    const name = `t_${randomUUID().replaceAll('-', '')}`;
    const admin0 = new pg.Client({ connectionString: url(info, 'postgres') });
    await admin0.connect();
    try {
      await admin0.query(
        `CREATE DATABASE ${admin0.escapeIdentifier(name)} TEMPLATE ${admin0.escapeIdentifier(info.template)}`,
      );
    } finally {
      await admin0.end();
    }
    const connectionString = url(info, name);
    const admin = new pg.Pool({ connectionString, max: 4, options: '-c search_path=app,public' });
    pools.push(admin);
    database = {
      name,
      info,
      connectionString,
      admin,
      pool: (role, max = 10) => {
        const created = new pg.Pool({
          connectionString,
          max,
          options: `-c role=${role} -c search_path=app,public`,
        });
        pools.push(created);
        return created;
      },
    };
  });

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (database !== undefined) {
      const info = database.info;
      const admin0 = new pg.Client({ connectionString: url(info, 'postgres') });
      await admin0.connect();
      try {
        await admin0.query(
          `DROP DATABASE IF EXISTS ${admin0.escapeIdentifier(database.name)} WITH (FORCE)`,
        );
      } finally {
        await admin0.end();
      }
    }
  });

  return () => {
    if (database === undefined) {
      throw new Error('test database is not initialised yet');
    }
    return database;
  };
}

export async function inTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  extra: Readonly<Record<string, string>> = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    for (const [key, value] of Object.entries(extra)) {
      await client.query('SELECT set_config($1, $2, true)', [key, value]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
