import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { detectDestructiveStatements } from './destructive.js';
import {
  compareReleases,
  MIGRATION_TRACKS,
  parseManifest,
  sha256Hex,
  type MigrationEntry,
  type MigrationManifest,
  type MigrationTrack,
} from './manifest.js';

export const MIGRATION_LOCK_KEY = 'velyric.migrations';
export const DEFAULT_OWNER_ROLE = 'velyric_owner';

export type MigrationErrorCode =
  | 'CHECKSUM_MISMATCH'
  | 'UNKNOWN_APPLIED_MIGRATION'
  | 'DESTRUCTIVE_STATEMENT'
  | 'CONTRACT_ORDER'
  | 'DEPENDENCY_NOT_APPLIED'
  | 'MIGRATION_FAILED'
  | 'PENDING_MIGRATIONS';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly migrationId: string | null;

  constructor(
    code: MigrationErrorCode,
    message: string,
    migrationId: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MigrationError';
    this.code = code;
    this.migrationId = migrationId;
  }
}

export interface MigrationRunOptions {
  readonly connectionString: string;
  readonly migrationsDir: string;
  readonly tracks?: readonly MigrationTrack[];
  readonly appliedBy?: string;
  readonly ownerRole?: string;
  readonly log?: (message: string) => void;
}

export interface AppliedMigrationRecord {
  readonly id: string;
  readonly track: string;
  readonly sha256: string;
  readonly appliedAt: Date;
  readonly appliedBy: string;
}

export interface MigrationPlan {
  readonly applied: readonly AppliedMigrationRecord[];
  readonly pending: readonly MigrationEntry[];
}

const BOOKKEEPING_SQL = `
CREATE SCHEMA IF NOT EXISTS velyric_meta;
CREATE TABLE IF NOT EXISTS velyric_meta.schema_migrations (
  id text PRIMARY KEY,
  track text NOT NULL,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL
);`;

const RECORD_SQL =
  'INSERT INTO velyric_meta.schema_migrations (id, track, sha256, applied_by) VALUES ($1, $2, $3, $4)';

interface AppliedRow {
  id: string;
  track: string;
  sha256: string;
  applied_at: Date;
  applied_by: string;
}

export async function loadManifest(migrationsDir: string): Promise<MigrationManifest> {
  const raw: unknown = JSON.parse(
    await readFile(path.join(migrationsDir, 'manifest.json'), 'utf8'),
  );
  return parseManifest(raw);
}

async function readMigrationSql(migrationsDir: string, entry: MigrationEntry): Promise<string> {
  const sqlText = await readFile(path.join(migrationsDir, entry.file), 'utf8');
  const actual = sha256Hex(sqlText);
  if (actual !== entry.sha256) {
    throw new MigrationError(
      'CHECKSUM_MISMATCH',
      `${entry.file} has sha256 ${actual} but the manifest records ${entry.sha256}`,
      entry.id,
    );
  }
  return sqlText;
}

async function readApplied(client: pg.ClientBase): Promise<AppliedMigrationRecord[]> {
  const exists = await client.query<{ present: boolean }>(
    "SELECT to_regclass('velyric_meta.schema_migrations') IS NOT NULL AS present",
  );
  if (exists.rows[0]?.present !== true) {
    return [];
  }
  const result = await client.query<AppliedRow>(
    'SELECT id, track, sha256, applied_at, applied_by FROM velyric_meta.schema_migrations ORDER BY applied_at, id',
  );
  return result.rows.map((row) => ({
    id: row.id,
    track: row.track,
    sha256: row.sha256,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
  }));
}

export function computePlan(
  manifest: MigrationManifest,
  applied: readonly AppliedMigrationRecord[],
  tracks: readonly MigrationTrack[],
): MigrationPlan {
  const byId = new Map(manifest.migrations.map((entry) => [entry.id, entry]));
  for (const record of applied) {
    const entry = byId.get(record.id);
    if (entry === undefined) {
      throw new MigrationError(
        'UNKNOWN_APPLIED_MIGRATION',
        `database contains migration ${record.id}, which is not in the manifest`,
        record.id,
      );
    }
    if (entry.sha256 !== record.sha256) {
      throw new MigrationError(
        'CHECKSUM_MISMATCH',
        `applied migration ${record.id} was recorded with sha256 ${record.sha256} but the manifest now has ${entry.sha256}`,
        record.id,
      );
    }
  }
  const appliedIds = new Set(applied.map((record) => record.id));
  const wanted = new Set<MigrationTrack>(tracks);
  const ordered = MIGRATION_TRACKS.flatMap((track) =>
    manifest.migrations.filter((entry) => entry.track === track),
  );
  return {
    applied,
    pending: ordered.filter((entry) => wanted.has(entry.track) && !appliedIds.has(entry.id)),
  };
}

export function assertMigrationAllowed(
  entry: MigrationEntry,
  manifest: MigrationManifest,
  appliedIds: ReadonlySet<string>,
  sqlText: string,
): void {
  for (const dependency of entry.dependsOn) {
    if (!appliedIds.has(dependency)) {
      throw new MigrationError(
        'DEPENDENCY_NOT_APPLIED',
        `${entry.id} requires ${dependency} to be applied first`,
        entry.id,
      );
    }
  }
  const findings = detectDestructiveStatements(sqlText);
  if (entry.phase !== 'contract' && findings.length > 0) {
    throw new MigrationError(
      'DESTRUCTIVE_STATEMENT',
      `${entry.id} is an ${entry.phase} migration but contains destructive statements: ${findings
        .map((finding) => `${finding.kind} (${finding.excerpt})`)
        .join('; ')}`,
      entry.id,
    );
  }
  if (entry.phase === 'contract') {
    const expand = manifest.migrations.find((candidate) => candidate.id === entry.contractOf);
    if (
      expand === undefined ||
      !appliedIds.has(expand.id) ||
      compareReleases(expand.releaseIntroduced, entry.releaseIntroduced) >= 0
    ) {
      throw new MigrationError(
        'CONTRACT_ORDER',
        `${entry.id} may only run after its expand migration shipped in an earlier release and was applied`,
        entry.id,
      );
    }
  }
}

async function withMigrationLock<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'velyric-migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

async function applyEntry(
  client: pg.Client,
  entry: MigrationEntry,
  sqlText: string,
  ownerRole: string,
  appliedBy: string,
): Promise<void> {
  const setRole = `SET LOCAL ROLE ${client.escapeIdentifier(ownerRole)}`;
  const params = [entry.id, entry.track, entry.sha256, appliedBy];
  if (entry.transactional) {
    await client.query('BEGIN');
    try {
      if (entry.runAsOwner) {
        await client.query(setRole);
      }
      await client.query(sqlText);
      await client.query('RESET ROLE');
      await client.query(RECORD_SQL, params);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return;
  }
  try {
    if (entry.runAsOwner) {
      await client.query(`SET ROLE ${client.escapeIdentifier(ownerRole)}`);
    }
    await client.query(sqlText);
  } finally {
    await client.query('RESET ROLE');
  }
  await client.query(RECORD_SQL, params);
}

export async function migrate(options: MigrationRunOptions): Promise<readonly string[]> {
  const manifest = await loadManifest(options.migrationsDir);
  const tracks = options.tracks ?? MIGRATION_TRACKS;
  const ownerRole = options.ownerRole ?? DEFAULT_OWNER_ROLE;
  const appliedBy = options.appliedBy ?? 'velyric-migrate';
  const log = options.log ?? ((): void => undefined);

  return withMigrationLock(options.connectionString, async (client) => {
    await client.query(BOOKKEEPING_SQL);
    const plan = computePlan(manifest, await readApplied(client), tracks);
    const appliedIds = new Set(plan.applied.map((record) => record.id));
    const appliedNow: string[] = [];
    for (const entry of plan.pending) {
      const sqlText = await readMigrationSql(options.migrationsDir, entry);
      assertMigrationAllowed(entry, manifest, appliedIds, sqlText);
      log(`applying ${entry.id}`);
      try {
        await applyEntry(client, entry, sqlText, ownerRole, appliedBy);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new MigrationError('MIGRATION_FAILED', `${entry.id} failed: ${detail}`, entry.id, {
          cause: error,
        });
      }
      appliedIds.add(entry.id);
      appliedNow.push(entry.id);
    }
    return appliedNow;
  });
}

export async function getMigrationStatus(
  options: Pick<MigrationRunOptions, 'connectionString' | 'migrationsDir' | 'tracks'>,
): Promise<MigrationPlan> {
  const manifest = await loadManifest(options.migrationsDir);
  const client = new pg.Client({
    connectionString: options.connectionString,
    application_name: 'velyric-migrate',
  });
  await client.connect();
  try {
    return computePlan(manifest, await readApplied(client), options.tracks ?? MIGRATION_TRACKS);
  } finally {
    await client.end();
  }
}

export async function verifyMigrations(
  options: Pick<MigrationRunOptions, 'connectionString' | 'migrationsDir' | 'tracks'>,
): Promise<MigrationPlan> {
  const plan = await getMigrationStatus(options);
  if (plan.pending.length > 0) {
    throw new MigrationError(
      'PENDING_MIGRATIONS',
      `pending migrations: ${plan.pending.map((entry) => entry.id).join(', ')}`,
      plan.pending[0]?.id ?? null,
    );
  }
  return plan;
}
