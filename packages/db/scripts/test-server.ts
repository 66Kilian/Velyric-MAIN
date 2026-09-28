import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneDatabase, createTemplateDatabase, startEmbeddedTestServer } from '../src/testing.js';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations',
);
const databaseName = process.argv[2] ?? 'velyric_service_tests';
const server = await startEmbeddedTestServer();
const template = 'velyric_template_core';
await createTemplateDatabase(server, { name: template, migrationsDir, tracks: ['core'] });
const url = await cloneDatabase(server, template, databaseName);
process.stdout.write(`VELYRIC_TEST_DATABASE_URL=${url}\n`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
setInterval(() => undefined, 60_000);
