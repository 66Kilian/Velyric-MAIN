import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadManifest,
  migrate,
  MigrationError,
  verifyMigrations,
} from '../src/migrations/runner.js';
import { inTenant, pgErrorCode, useMigratedDatabase } from './support/db.js';

const database = useMigratedDatabase();

const RLS_EXEMPT = new Set([
  'outbox_events',
  'provider_webhook_events',
  'webhook_processing',
  'tenant_search_index',
  'webhook_delivery_queue',
  'api_key_directory',
  'phone_number_directory',
  'billing_customer_directory',
  'invitation_directory',
]);

async function seedTenant(tenantId: string, slug: string): Promise<void> {
  await database().admin.query(
    `INSERT INTO app.tenants (id, legal_name, display_name, slug) VALUES ($1, $2, $2, $3)`,
    [tenantId, `Tenant ${slug}`, slug],
  );
}

describe('migrations', () => {
  it('applies every manifest migration for the template tracks and is idempotent', async () => {
    const db = database();
    const manifest = await loadManifest(db.info.migrationsDir);
    const expected = manifest.migrations
      .filter((entry) => db.info.tracks.includes(entry.track))
      .map((entry) => entry.id);
    const applied = await db.admin.query<{ id: string }>(
      'SELECT id FROM velyric_meta.schema_migrations ORDER BY id',
    );
    expect(applied.rows.map((row) => row.id).sort()).toEqual([...expected].sort());
    expect(
      await migrate({
        connectionString: db.connectionString,
        migrationsDir: db.info.migrationsDir,
        tracks: db.info.tracks,
      }),
    ).toEqual([]);
    await expect(
      verifyMigrations({
        connectionString: db.connectionString,
        migrationsDir: db.info.migrationsDir,
        tracks: db.info.tracks,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses to run when an applied migration file was edited', async () => {
    const db = database();
    const copy = await mkdtemp(path.join(tmpdir(), 'velyric-migrations-'));
    try {
      await cp(db.info.migrationsDir, copy, { recursive: true });
      const manifestPath = path.join(copy, 'manifest.json');
      const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        migrations: { sha256: string }[];
      };
      const first = raw.migrations[0];
      if (first === undefined) {
        throw new Error('manifest is empty');
      }
      first.sha256 = 'f'.repeat(64);
      await writeFile(manifestPath, JSON.stringify(raw));
      const error: unknown = await migrate({
        connectionString: db.connectionString,
        migrationsDir: copy,
        tracks: db.info.tracks,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe('CHECKSUM_MISMATCH');
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe('schema security posture', () => {
  it('enables and forces row level security on every tenant-owned table', async () => {
    const result = await database().admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      ORDER BY c.relname`);
    const unprotected = result.rows
      .filter((row) => !RLS_EXEMPT.has(row.relname))
      .filter((row) => !row.relrowsecurity || !row.relforcerowsecurity || row.policies === 0)
      .map((row) => row.relname);
    expect(result.rows.length).toBeGreaterThan(50);
    expect(unprotected).toEqual([]);
  });

  it('keeps RLS-exempt tables unreadable for the application role', async () => {
    const app = database().pool('velyric_app', 2);
    for (const table of ['outbox_events', 'tenant_search_index', 'webhook_delivery_queue']) {
      const error: unknown = await app
        .query(`SELECT * FROM app.${table} LIMIT 1`)
        .catch((caught: unknown) => caught);
      expect(pgErrorCode(error), table).toBe('42501');
    }
  });

  it('denies DDL to the application role', async () => {
    const app = database().pool('velyric_app', 2);
    const error: unknown = await app
      .query('CREATE TABLE app.evil (id int)')
      .catch((caught: unknown) => caught);
    expect(pgErrorCode(error)).toBe('42501');
  });

  it('hides other tenants and rejects writes with a foreign tenant_id', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await seedTenant(tenantA, `a-${tenantA.slice(0, 8)}`);
    await seedTenant(tenantB, `b-${tenantB.slice(0, 8)}`);
    await database().admin.query(
      `INSERT INTO app.locations (tenant_id, name, timezone, country) VALUES ($1, 'HQ', 'Europe/Budapest', 'HU')`,
      [tenantA],
    );
    const app = database().pool('velyric_app', 2);

    const visible = await inTenant(app, tenantB, (client) =>
      client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM app.locations WHERE tenant_id = $1',
        [tenantA],
      ),
    );
    expect(visible.rows[0]?.n).toBe(0);

    const unscoped = await app.query<{ n: number }>('SELECT count(*)::int AS n FROM app.locations');
    expect(unscoped.rows[0]?.n).toBe(0);

    const insertError: unknown = await inTenant(app, tenantB, (client) =>
      client.query(
        `INSERT INTO app.locations (tenant_id, name, timezone, country) VALUES ($1, 'Evil', 'UTC', 'HU')`,
        [tenantA],
      ),
    ).catch((caught: unknown) => caught);
    expect(pgErrorCode(insertError)).toBe('42501');

    const updated = await inTenant(app, tenantB, (client) =>
      client.query(`UPDATE app.locations SET name = 'pwned' WHERE tenant_id = $1`, [tenantA]),
    );
    expect(updated.rowCount).toBe(0);

    const own = await inTenant(app, tenantA, (client) =>
      client.query<{ n: number }>('SELECT count(*)::int AS n FROM app.locations'),
    );
    expect(own.rows[0]?.n).toBe(1);
  });
});
