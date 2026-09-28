import { randomUUID } from 'node:crypto';
import { createDatabase, type DB } from '@velyric/db';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import './provided.js';

export interface TestDatabase {
  readonly db: Kysely<DB>;
  readonly admin: pg.Pool;
}

export interface SeededLocation {
  readonly tenantId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly resourceId: string;
}

function connectionString(database: string): string {
  const provided = inject('connectorWorkerDb');
  return `postgres://${encodeURIComponent(provided.user)}:${encodeURIComponent(provided.password)}@${provided.host}:${String(provided.port)}/${database}`;
}

export function useTestDatabase(): () => TestDatabase {
  let database: TestDatabase | undefined;
  const name = `connector_worker_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const provided = inject('connectorWorkerDb');
    const root = new pg.Client({ connectionString: connectionString('postgres') });
    await root.connect();
    try {
      await root.query(
        `CREATE DATABASE ${root.escapeIdentifier(name)} TEMPLATE ${root.escapeIdentifier(provided.template)}`,
      );
    } finally {
      await root.end();
    }
    database = {
      db: createDatabase<DB>({
        connectionString: connectionString(name),
        applicationName: 'connector-worker-test',
        assumeRole: 'velyric_app',
        maxConnections: 12,
      }),
      admin: new pg.Pool({
        connectionString: connectionString(name),
        max: 4,
        options: '-c search_path=app,public',
      }),
    };
  });
  afterAll(async () => {
    await database?.db.destroy();
    await database?.admin.end();
  });
  return () => {
    if (database === undefined) {
      throw new Error('test database is not initialised');
    }
    return database;
  };
}

export async function seedTenant(admin: pg.Pool): Promise<string> {
  const slug = `tenant-${randomUUID().slice(0, 12)}`;
  const result = await admin.query<{ id: string }>(
    `INSERT INTO app.tenants (legal_name, display_name, slug) VALUES ('Demo Rendelő Kft.', 'Demo Rendelő', $1) RETURNING id`,
    [slug],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('tenant insert returned no row');
  }
  return row.id;
}

export async function seedBookableLocation(
  admin: pg.Pool,
  options: {
    readonly tenantId?: string;
    readonly cancellationWindowMinutes?: number;
    readonly calendarIntegrationId?: string;
    readonly calendarRef?: string;
  } = {},
): Promise<SeededLocation> {
  const tenantId = options.tenantId ?? (await seedTenant(admin));
  const location = await admin.query<{ id: string }>(
    `INSERT INTO app.locations (tenant_id, name, country, timezone) VALUES ($1, 'Központ', 'HU', 'Europe/Budapest') RETURNING id`,
    [tenantId],
  );
  const locationId = location.rows[0]?.id ?? '';
  const service = await admin.query<{ id: string }>(
    `INSERT INTO app.services (tenant_id, location_id, name, duration_minutes, buffer_after_minutes, required_resource_types, cancellation_window_minutes)
     VALUES ($1, $2, 'Konzultáció', 30, 10, ARRAY['DOCTOR'], $3) RETURNING id`,
    [tenantId, locationId, options.cancellationWindowMinutes ?? 120],
  );
  const serviceId = service.rows[0]?.id ?? '';
  const resource = await admin.query<{ id: string }>(
    `INSERT INTO app.resources (tenant_id, location_id, name, resource_type, parallel_slots, calendar_integration_id, external_calendar_ref)
     VALUES ($1, $2, 'Dr. Kiss', 'DOCTOR', 1, $3, $4) RETURNING id`,
    [tenantId, locationId, options.calendarIntegrationId ?? null, options.calendarRef ?? null],
  );
  const resourceId = resource.rows[0]?.id ?? '';
  await admin.query(
    `INSERT INTO app.availability_rules (tenant_id, resource_id, iso_weekday, start_local, end_local, timezone)
     SELECT $1, $2, day, '08:00', '12:00', 'Europe/Budapest' FROM generate_series(1, 7) AS day`,
    [tenantId, resourceId],
  );
  return { tenantId, locationId, serviceId, resourceId };
}
