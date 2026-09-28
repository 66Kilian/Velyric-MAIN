import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

export const DATABASE_ROLES = [
  'velyric_app',
  'velyric_metering',
  'velyric_readonly',
  'velyric_support',
] as const;
export type DatabaseRole = (typeof DATABASE_ROLES)[number];

export interface DatabaseConnectionOptions {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly maxConnections?: number;
  readonly assumeRole?: DatabaseRole;
  readonly statementTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  readonly ssl?: pg.PoolConfig['ssl'];
}

const APPLICATION_NAME_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

export function buildConnectionOptionsString(options: DatabaseConnectionOptions): string {
  const statementTimeout = options.statementTimeoutMs ?? 15_000;
  const idleTimeout = options.idleInTransactionTimeoutMs ?? 30_000;
  if (!Number.isInteger(statementTimeout) || statementTimeout <= 0) {
    throw new RangeError('statementTimeoutMs must be a positive integer');
  }
  if (!Number.isInteger(idleTimeout) || idleTimeout <= 0) {
    throw new RangeError('idleInTransactionTimeoutMs must be a positive integer');
  }
  const parts = [
    '-c search_path=app,public',
    `-c statement_timeout=${String(statementTimeout)}`,
    `-c idle_in_transaction_session_timeout=${String(idleTimeout)}`,
  ];
  if (options.assumeRole !== undefined) {
    if (!(DATABASE_ROLES as readonly string[]).includes(options.assumeRole)) {
      throw new RangeError(`unsupported database role ${options.assumeRole}`);
    }
    parts.push(`-c role=${options.assumeRole}`);
  }
  return parts.join(' ');
}

export function createPool(options: DatabaseConnectionOptions): pg.Pool {
  if (!APPLICATION_NAME_PATTERN.test(options.applicationName)) {
    throw new RangeError('applicationName must be a lowercase service identifier');
  }
  const config: pg.PoolConfig = {
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    options: buildConnectionOptionsString(options),
  };
  if (options.ssl !== undefined) {
    config.ssl = options.ssl;
  }
  return new pg.Pool(config);
}

export function createDatabase<Database>(options: DatabaseConnectionOptions): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: createPool(options) }) });
}
