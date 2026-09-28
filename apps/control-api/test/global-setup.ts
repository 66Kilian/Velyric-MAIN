import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemplateDatabase,
  externalTestServer,
  startEmbeddedTestServer,
  type TestDatabaseServer,
} from '../../../packages/db/src/testing.js';
import type { TestProject } from 'vitest/node';
import './support/provided.js';

let server: TestDatabaseServer | undefined;

export async function setup(project: TestProject): Promise<void> {
  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../db/migrations',
  );
  const externalUrl = process.env['VELYRIC_TEST_DATABASE_URL'];
  server =
    externalUrl === undefined || externalUrl === ''
      ? await startEmbeddedTestServer()
      : externalTestServer(externalUrl);
  const template = 'velyric_control_api_template';
  await createTemplateDatabase(server, { name: template, migrationsDir, tracks: ['core'] });
  project.provide('controlApiDb', {
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
    template,
  });
}

export async function teardown(): Promise<void> {
  await server?.stop();
}
