import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENUM_COLUMN_BINDINGS, enumConstraintName } from '../src/enum-columns.js';
import { useMigratedDatabase } from './support/db.js';

const database = useMigratedDatabase();

interface EnumsJson {
  readonly enums: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

async function loadEnums(): Promise<EnumsJson> {
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../contracts/generated/enums.json',
  );
  return JSON.parse(await readFile(file, 'utf8')) as EnumsJson;
}

describe('enum CHECK constraints', () => {
  it('match packages/contracts/generated/enums.json for every bound column', async () => {
    const enums = await loadEnums();
    const result = await database().admin.query<{
      table_name: string;
      conname: string;
      definition: string;
    }>(`
      SELECT c.relname AS table_name, k.conname, pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND k.contype = 'c' AND k.convalidated`);
    const byName = new Map(result.rows.map((row) => [row.conname, row.definition]));
    const mismatches: string[] = [];
    for (const binding of ENUM_COLUMN_BINDINGS) {
      const definition = byName.get(enumConstraintName(binding));
      const expected = [...new Set(Object.values(enums.enums[binding.enumName] ?? {}))].sort();
      if (definition === undefined) {
        mismatches.push(`${binding.table}.${binding.column}: constraint missing`);
        continue;
      }
      const actual = [
        ...new Set(
          [...definition.matchAll(/'((?:[^']|'')*)'/g)].map((match) =>
            (match[1] ?? '').replaceAll("''", "'"),
          ),
        ),
      ].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `${binding.table}.${binding.column}: db=[${actual.join(',')}] enums=[${expected.join(',')}]`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('rejects values outside the enum', async () => {
    const error: unknown = await database()
      .admin.query(
        `INSERT INTO app.tenants (legal_name, display_name, slug, status) VALUES ('X', 'X', 'bad-status-tenant', 'HACKED')`,
      )
      .catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe('23514');
  });
});
