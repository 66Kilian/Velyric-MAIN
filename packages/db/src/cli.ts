#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { simulatorPriceBook } from '@velyric/testkit';
import { MIGRATION_TRACKS, type MigrationTrack } from './migrations/manifest.js';
import {
  getMigrationStatus,
  migrate,
  MigrationError,
  verifyMigrations,
} from './migrations/runner.js';
import { SeedEnvironmentError, seedLocal } from './seeds.js';

const USAGE = 'usage: velyric-migrate <migrate|status|verify|seed> [--tracks core,vector]';

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function tracksFrom(argv: readonly string[]): readonly MigrationTrack[] {
  const index = argv.indexOf('--tracks');
  if (index === -1) {
    return MIGRATION_TRACKS;
  }
  const requested = (argv[index + 1] ?? '').split(',').filter((track) => track !== '');
  const tracks = requested.filter((track): track is MigrationTrack =>
    (MIGRATION_TRACKS as readonly string[]).includes(track),
  );
  if (tracks.length === 0 || tracks.length !== requested.length) {
    fail(`CONFIG_INVALID: --tracks must list ${MIGRATION_TRACKS.join(', ')}`, 64);
  }
  return tracks;
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0] ?? '';
  const connectionString =
    process.env['VELYRIC_DATABASE_MIGRATOR_URL'] ?? process.env['VELYRIC_DATABASE_URL'] ?? '';
  if (!/^postgres(ql)?:\/\//.test(connectionString)) {
    fail(
      'CONFIG_INVALID: VELYRIC_DATABASE_MIGRATOR_URL is required and must be a postgres URL',
      78,
    );
  }
  const migrationsDir =
    process.env['VELYRIC_MIGRATIONS_DIR'] ??
    fileURLToPath(new URL('../../../db/migrations', import.meta.url));
  const tracks = tracksFrom(argv);
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  switch (command) {
    case 'migrate': {
      const applied = await migrate({
        connectionString,
        migrationsDir,
        tracks,
        log,
        appliedBy: process.env['VELYRIC_MIGRATION_ACTOR'] ?? 'velyric-migrate',
      });
      log(
        applied.length === 0
          ? 'database is up to date'
          : `applied ${String(applied.length)} migration(s)`,
      );
      return;
    }
    case 'status': {
      const plan = await getMigrationStatus({ connectionString, migrationsDir, tracks });
      for (const record of plan.applied) {
        log(`applied  ${record.id}  ${record.appliedAt.toISOString()}  ${record.appliedBy}`);
      }
      for (const entry of plan.pending) {
        log(`pending  ${entry.id}`);
      }
      return;
    }
    case 'verify': {
      const plan = await verifyMigrations({ connectionString, migrationsDir, tracks });
      log(`verified ${String(plan.applied.length)} applied migration(s)`);
      return;
    }
    case 'seed': {
      const result = await seedLocal({
        connectionString,
        environment: process.env['VELYRIC_ENV'] ?? '',
        priceBook: simulatorPriceBook(),
      });
      log(`seeded ${String(result.priceBookRows)} price book row(s)`);
      return;
    }
    default:
      fail(USAGE, 64);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof MigrationError) {
    fail(`${error.code}: ${error.message}`, 1);
  }
  if (error instanceof SeedEnvironmentError) {
    fail(error.message, 78);
  }
  throw error;
}
