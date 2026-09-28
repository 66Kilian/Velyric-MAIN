import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTemplateDatabase, startEmbeddedTestServer } from '../src/testing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const migrationsDir = path.resolve(packageRoot, '../../db/migrations');
const outFile = path.join(packageRoot, 'src/schema.ts');
const verify = process.argv.includes('--check');

function resolveCodegenBin(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('kysely-codegen/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin: string | Record<string, string>;
  };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin['kysely-codegen'];
  if (bin === undefined) {
    throw new Error('kysely-codegen does not declare a kysely-codegen binary');
  }
  return path.resolve(path.dirname(manifestPath), bin);
}

async function main(): Promise<void> {
  const server = await startEmbeddedTestServer();
  try {
    const database = 'velyric_codegen';
    await createTemplateDatabase(server, { name: database, migrationsDir, tracks: ['core'] });
    const admin = server.connectionString('postgres');
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: admin });
    await client.connect();
    try {
      await client.query(`ALTER DATABASE ${database} WITH ALLOW_CONNECTIONS true`);
    } finally {
      await client.end();
    }
    const args = [
      resolveCodegenBin(),
      '--dialect',
      'postgres',
      '--url',
      server.connectionString(database),
      '--default-schema',
      'app',
      '--include-pattern',
      '(app|analytics|support).*',
      '--exclude-pattern',
      'velyric_meta.*',
      '--out-file',
      outFile,
      '--date-parser',
      'timestamp',
      '--numeric-parser',
      'string',
      ...(verify ? ['--verify'] : []),
    ];
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: packageRoot });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
    }
  } finally {
    await server.stop();
  }
}

await main();
