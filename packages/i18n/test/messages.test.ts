import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiErrorCode,
  CallIntentCategory,
  CallOutcome,
  KnowledgeSourceStatus,
  ProvisioningState,
  Role,
} from '@velyric/contracts';
import { describe, expect, it } from 'vitest';
import {
  flattenMessages,
  icuArguments,
  LOCALES,
  MESSAGE_NAMESPACES,
  type MessageTree,
} from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');

function read(locale: string, namespace: string): MessageTree | null {
  const file = path.join(root, locale, `${namespace}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as MessageTree) : null;
}

describe('message catalogs', () => {
  it('only contains known namespaces and every namespace exists in every locale', () => {
    for (const locale of LOCALES) {
      const files = readdirSync(path.join(root, locale)).map((file) => file.replace(/\.json$/, ''));
      expect(
        files.filter((file) => !(MESSAGE_NAMESPACES as readonly string[]).includes(file)),
      ).toEqual([]);
    }
    const namespaces = new Set(
      LOCALES.flatMap((locale) =>
        readdirSync(path.join(root, locale)).map((file) => file.replace(/\.json$/, '')),
      ),
    );
    for (const namespace of namespaces) {
      for (const locale of LOCALES) {
        expect(read(locale, namespace), `${locale}/${namespace}.json`).not.toBeNull();
      }
    }
  });

  it('has identical keys, valid ICU syntax and matching arguments across locales', () => {
    for (const namespace of MESSAGE_NAMESPACES) {
      const reference = read('en', namespace);
      if (reference === null) {
        continue;
      }
      const referenceFlat = flattenMessages(reference);
      for (const locale of LOCALES) {
        const flat = flattenMessages(read(locale, namespace) ?? {});
        expect([...flat.keys()].sort(), `${locale}/${namespace} keys`).toEqual(
          [...referenceFlat.keys()].sort(),
        );
        for (const [key, message] of flat) {
          expect(message.trim(), `${locale}/${namespace}.${key} is empty`).not.toBe('');
          expect(
            key.split('.').every((segment) => !segment.includes(' ')),
            `${namespace}.${key}`,
          ).toBe(true);
          expect(icuArguments(message), `${locale}/${namespace}.${key} arguments`).toEqual(
            icuArguments(referenceFlat.get(key) ?? ''),
          );
        }
      }
    }
  });

  it('translates every API error code and the enums shown in the product', () => {
    for (const locale of LOCALES) {
      const errors = flattenMessages(read(locale, 'errors') ?? {});
      for (const code of Object.values(ApiErrorCode)) {
        expect(errors.has(`codes.${code}`), `${locale} errors.codes.${code}`).toBe(true);
      }
      const enums = flattenMessages(read(locale, 'enums') ?? {});
      const groups: [string, readonly string[]][] = [
        ['callOutcome', Object.values(CallOutcome)],
        ['callIntent', Object.values(CallIntentCategory)],
        ['knowledgeSourceStatus', Object.values(KnowledgeSourceStatus)],
        ['provisioningState', Object.values(ProvisioningState)],
        ['role', Object.values(Role)],
      ];
      for (const [group, values] of groups) {
        for (const value of values) {
          expect(enums.has(`${group}.${value}`), `${locale} enums.${group}.${value}`).toBe(true);
        }
      }
    }
  });
});
