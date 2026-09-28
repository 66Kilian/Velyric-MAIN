import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import type { MigrationTrack } from '../src/migrations/manifest.js';
import {
  createTemplateDatabase,
  externalTestServer,
  startEmbeddedTestServer,
  type TestDatabaseServer,
} from '../src/testing.js';
import './support/provided.js';

let server: TestDatabaseServer | undefined;

export async function setup(project: TestProject): Promise<void> {
  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../db/migrations',
  );
  const externalUrl = process.env['VELYRIC_TEST_DATABASE_URL'];
  const requireFull =
    process.env['VELYRIC_REQUIRE_FULL_DB'] === '1' || process.env['CI'] === 'true';
  if (requireFull && (externalUrl === undefined || externalUrl === '')) {
    throw new Error(
      'VELYRIC_TEST_DATABASE_URL must point at a pgvector-enabled PostgreSQL 18 server in CI',
    );
  }
  server =
    externalUrl === undefined || externalUrl === ''
      ? await startEmbeddedTestServer()
      : externalTestServer(externalUrl);
  const tracks: MigrationTrack[] = server.kind === 'external' ? ['core', 'vector'] : ['core'];
  const template = `velyric_template_${tracks.join('_')}`;
  await createTemplateDatabase(server, { name: template, migrationsDir, tracks });
  project.provide('velyricDb', {
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
    template,
    tracks,
    migrationsDir,
  });
}

export async function teardown(): Promise<void> {
  await server?.stop();
}
