import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import getPort from 'get-port';
import pg from 'pg';
import type { MigrationTrack } from './migrations/manifest.js';
import { migrate } from './migrations/runner.js';

export interface TestDatabaseServer {
  readonly kind: 'embedded' | 'external';
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  connectionString(database: string): string;
  stop(): Promise<void>;
}

function buildConnectionString(
  user: string,
  password: string,
  host: string,
  port: number,
  database: string,
): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${String(port)}/${encodeURIComponent(database)}`;
}

export async function startEmbeddedTestServer(): Promise<TestDatabaseServer> {
  const databaseDir = await mkdtemp(path.join(tmpdir(), 'velyric-pg-'));
  const port = await getPort();
  const user = 'postgres';
  const password = 'velyric-test';
  const server = new EmbeddedPostgres({
    databaseDir,
    port,
    user,
    password,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  return {
    kind: 'embedded',
    host: '127.0.0.1',
    port,
    user,
    password,
    connectionString: (database) =>
      buildConnectionString(user, password, '127.0.0.1', port, database),
    stop: async () => {
      await server.stop();
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}

export function externalTestServer(url: string): TestDatabaseServer {
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const host = parsed.hostname;
  const port = parsed.port === '' ? 5432 : Number(parsed.port);
  return {
    kind: 'external',
    host,
    port,
    user,
    password,
    connectionString: (database) => buildConnectionString(user, password, host, port, database),
    stop: () => Promise.resolve(),
  };
}

async function withAdminClient<T>(
  server: TestDatabaseServer,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: server.connectionString('postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTemplateDatabase(
  server: TestDatabaseServer,
  options: {
    readonly name: string;
    readonly migrationsDir: string;
    readonly tracks: readonly MigrationTrack[];
  },
): Promise<void> {
  await withAdminClient(server, async (client) => {
    const name = client.escapeIdentifier(options.name);
    await client.query(`ALTER DATABASE ${name} WITH IS_TEMPLATE false`).catch(() => undefined);
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
  });
  await migrate({
    connectionString: server.connectionString(options.name),
    migrationsDir: options.migrationsDir,
    tracks: options.tracks,
    appliedBy: 'velyric-test',
  });
  await withAdminClient(server, async (client) => {
    await client.query(
      `ALTER DATABASE ${client.escapeIdentifier(options.name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
    );
  });
}

export async function cloneDatabase(
  server: TestDatabaseServer,
  template: string,
  name: string,
): Promise<string> {
  await withAdminClient(server, async (client) => {
    await client.query(
      `CREATE DATABASE ${client.escapeIdentifier(name)} TEMPLATE ${client.escapeIdentifier(template)}`,
    );
  });
  return server.connectionString(name);
}

export async function dropDatabase(server: TestDatabaseServer, name: string): Promise<void> {
  await withAdminClient(server, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`);
  });
}
