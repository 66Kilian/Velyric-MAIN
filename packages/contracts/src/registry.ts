import type { EnumDefinition } from './enum-utils.js';
import * as enums from './enums.js';
import * as topology from './topology.js';

const PASCAL_CASE_CHARACTERS = /^[A-Z][A-Za-z0-9]*$/;
const LOWERCASE_LETTER = /[a-z]/;

function isEnumName(name: string): boolean {
  return PASCAL_CASE_CHARACTERS.test(name) && LOWERCASE_LETTER.test(name);
}

function isEnumDefinition(value: unknown): value is EnumDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function collect(
  modules: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, EnumDefinition>> {
  const entries: [string, EnumDefinition][] = [];
  for (const module of modules) {
    for (const [name, value] of Object.entries(module)) {
      if (isEnumName(name) && isEnumDefinition(value)) {
        entries.push([name, value]);
      }
    }
  }
  entries.sort(([left], [right]) => left.localeCompare(right, 'en'));
  return Object.freeze(Object.fromEntries(entries));
}

export const ENUM_REGISTRY: Readonly<Record<string, EnumDefinition>> = collect([enums, topology]);

export const ENUMS_JSON_SCHEMA_VERSION = 1;

export function renderEnumsJson(): string {
  return `${JSON.stringify({ schema_version: ENUMS_JSON_SCHEMA_VERSION, enums: ENUM_REGISTRY }, null, 2)}\n`;
}
