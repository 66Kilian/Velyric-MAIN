import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION_TRACKS,
  parseManifest,
  serializeManifest,
  sha256Hex,
  validateManifest,
  type MigrationEntry,
  type MigrationManifest,
} from '../src/migrations/manifest.js';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations',
);
const manifestPath = path.join(migrationsDir, 'manifest.json');
const checkOnly = process.argv.includes('--check');
const release = process.env['VELYRIC_RELEASE'] ?? '2026.09.0';

const NOT_AS_OWNER = new Set([
  'core/0001_roles_extensions_schemas',
  'vector/0001_knowledge_embeddings',
]);

async function loadExisting(): Promise<MigrationManifest | null> {
  if (!existsSync(manifestPath)) {
    return null;
  }
  return parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
}

async function main(): Promise<void> {
  const existing = await loadExisting();
  const previous = new Map((existing?.migrations ?? []).map((entry) => [entry.id, entry]));
  const migrations: MigrationEntry[] = [];

  for (const track of MIGRATION_TRACKS) {
    const trackDir = path.join(migrationsDir, track);
    const files = existsSync(trackDir)
      ? (await readdir(trackDir)).filter((file) => file.endsWith('.sql')).sort()
      : [];
    for (const file of files) {
      const id = `${track}/${file.slice(0, -'.sql'.length)}`;
      const sha256 = sha256Hex(await readFile(path.join(trackDir, file), 'utf8'));
      const prior = previous.get(id);
      migrations.push(
        prior === undefined
          ? {
              id,
              track,
              file: `${id}.sql`,
              sha256,
              phase: 'expand',
              transactional: true,
              runAsOwner: !NOT_AS_OWNER.has(id),
              requiresExtensions: track === 'vector' ? ['vector'] : [],
              dependsOn: track === 'vector' ? ['core/0008_row_security_grants_views'] : [],
              contractOf: null,
              releaseIntroduced: release,
            }
          : { ...prior, sha256 },
      );
    }
  }

  const next: MigrationManifest = { schemaVersion: 1, migrations };
  validateManifest(next);
  const serialized = serializeManifest(next);
  const current = existsSync(manifestPath) ? await readFile(manifestPath, 'utf8') : '';

  if (checkOnly) {
    if (serialized !== current) {
      process.stderr.write(
        'db/migrations/manifest.json is out of date; run pnpm --filter @velyric/db manifest:update\n',
      );
      process.exitCode = 1;
    }
    return;
  }
  if (serialized !== current) {
    await writeFile(manifestPath, serialized, 'utf8');
    process.stdout.write(
      `updated ${path.relative(process.cwd(), manifestPath)} (${String(migrations.length)} migrations)\n`,
    );
  }
}

await main();
