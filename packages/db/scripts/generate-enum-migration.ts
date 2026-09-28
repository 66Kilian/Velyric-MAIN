import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENUM_COLUMN_BINDINGS,
  enumCheckExpression,
  enumConstraintName,
} from '../src/enum-columns.js';

interface EnumsJson {
  readonly schema_version: number;
  readonly enums: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

type Snapshot = Record<string, readonly string[]>;

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../db/migrations');
const snapshotPath = path.join(migrationsDir, 'enum-snapshot.json');
const enumsPath = path.resolve(here, '../../contracts/generated/enums.json');
const checkOnly = process.argv.includes('--check');
const nameArg =
  process.argv.find((arg) => arg.startsWith('--name='))?.slice('--name='.length) ??
  'enum_check_constraints';

function bindingKey(table: string, column: string): string {
  return `${table}.${column}`;
}

async function main(): Promise<void> {
  const enums = JSON.parse(await readFile(enumsPath, 'utf8')) as EnumsJson;
  const previous: Snapshot = existsSync(snapshotPath)
    ? (JSON.parse(await readFile(snapshotPath, 'utf8')) as Snapshot)
    : {};
  const next: Snapshot = {};
  const statements: string[] = [];
  const missing: string[] = [];

  for (const binding of ENUM_COLUMN_BINDINGS) {
    const definition = enums.enums[binding.enumName];
    if (definition === undefined) {
      missing.push(`${bindingKey(binding.table, binding.column)} -> ${binding.enumName}`);
      continue;
    }
    const values = [...new Set(Object.values(definition))].sort();
    const key = bindingKey(binding.table, binding.column);
    next[key] = values;
    const prior = previous[key];
    if (
      prior !== undefined &&
      prior.length === values.length &&
      prior.every((value, index) => value === values[index])
    ) {
      continue;
    }
    const constraint = enumConstraintName(binding);
    if (prior !== undefined) {
      statements.push(`ALTER TABLE app.${binding.table} DROP CONSTRAINT IF EXISTS ${constraint};`);
    }
    statements.push(
      `ALTER TABLE app.${binding.table} ADD CONSTRAINT ${constraint} CHECK (${enumCheckExpression(binding, values)}) NOT VALID;`,
      `ALTER TABLE app.${binding.table} VALIDATE CONSTRAINT ${constraint};`,
    );
  }

  if (missing.length > 0) {
    throw new Error(`enum bindings reference unknown enums:\n${missing.join('\n')}`);
  }

  const orphaned = Object.keys(previous).filter((key) => next[key] === undefined);
  if (orphaned.length > 0) {
    throw new Error(
      `enum snapshot contains bindings that were removed from ENUM_COLUMN_BINDINGS: ${orphaned.join(', ')}`,
    );
  }

  if (checkOnly) {
    if (statements.length > 0) {
      process.stderr.write(
        `enum CHECK constraints are out of date for ${String(statements.length)} statements; run pnpm --filter @velyric/db enums:migration\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (statements.length === 0) {
    process.stdout.write('enum CHECK constraints are up to date\n');
    return;
  }

  const coreDir = path.join(migrationsDir, 'core');
  const numbers = (await readdir(coreDir))
    .map((file) => /^(\d{4})_/.exec(file)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  const nextNumber = String(Math.max(0, ...numbers) + 1).padStart(4, '0');
  const file = path.join(coreDir, `${nextNumber}_${nameArg}.sql`);
  await writeFile(file, `${statements.join('\n')}\n`, 'utf8');
  await writeFile(snapshotPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `wrote ${path.relative(process.cwd(), file)} and updated enum-snapshot.json\n`,
  );
}

await main();
