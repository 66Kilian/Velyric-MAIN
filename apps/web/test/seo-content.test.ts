import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMPARISONS,
  GLOSSARY_TERMS,
  INTEGRATIONS,
  type ContentEntry,
} from '@/content/collections';
import { LOCALES, type AppLocale } from '@/i18n/routing';

const MESSAGES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/i18n/messages',
);

type Tree = { readonly [key: string]: string | Tree };

function read(locale: AppLocale, namespace: string): Tree {
  return JSON.parse(
    readFileSync(path.join(MESSAGES, locale, `${namespace}.json`), 'utf8'),
  ) as Tree;
}

function at(tree: Tree, dotted: string): string | Tree | undefined {
  let node: string | Tree | undefined = tree;
  for (const segment of dotted.split('.')) {
    if (typeof node !== 'object') {
      return undefined;
    }
    node = node[segment];
  }
  return node;
}

function flatten(tree: Tree, prefix = ''): readonly (readonly [string, string])[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const next = prefix === '' ? key : `${prefix}.${key}`;
    return typeof value === 'string' ? [[next, value] as const] : flatten(value, next);
  });
}

const NEW_NAMESPACES = [
  'marketingCapabilities',
  'marketingIntegrations',
  'marketingCompare',
  'marketingGlossary',
  'marketingContact',
] as const;

const REQUIRED_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  marketingCapabilities: ['receptionist', 'booking', 'multilingual', 'transfer'],
  marketingIntegrations: INTEGRATIONS.map((entry) => entry.id),
  marketingCompare: COMPARISONS.map((entry) => entry.id),
  marketingGlossary: ['hub', 'terms'],
  marketingContact: ['meta', 'answer', 'channels', 'faq', 'related'],
};

describe('marketing content catalogues', () => {
  it('registers every new namespace in every locale', () => {
    for (const locale of LOCALES) {
      const files = readdirSync(path.join(MESSAGES, locale));
      for (const namespace of NEW_NAMESPACES) {
        expect(files, `${locale}/${namespace}`).toContain(`${namespace}.json`);
      }
    }
  });

  it('never ships an empty catalogue', () => {
    for (const locale of LOCALES) {
      for (const namespace of NEW_NAMESPACES) {
        const entries = flatten(read(locale, namespace));
        expect(entries.length, `${locale}/${namespace}`).toBeGreaterThan(20);
      }
    }
  });

  it('contains a section for every routed content entry', () => {
    for (const locale of LOCALES) {
      for (const namespace of NEW_NAMESPACES) {
        const tree = read(locale, namespace);
        for (const section of REQUIRED_SECTIONS[namespace] ?? []) {
          expect(at(tree, section), `${locale}/${namespace}.${section}`).toBeDefined();
        }
      }
    }
  });

  it('gives every glossary term its own entry', () => {
    for (const locale of LOCALES) {
      const tree = read(locale, 'marketingGlossary');
      for (const term of GLOSSARY_TERMS) {
        expect(at(tree, `terms.${term.id}`), `${locale}/glossary/${term.id}`).toBeDefined();
      }
    }
  });

  it('never contains placeholder or untranslated marker text', () => {
    const forbidden = /\b(TODO|FIXME|lorem ipsum|placeholder|coming soon|tbd|xxx)\b/i;
    for (const locale of LOCALES) {
      for (const namespace of NEW_NAMESPACES) {
        for (const [key, value] of flatten(read(locale, namespace))) {
          expect(forbidden.test(value), `${locale}/${namespace}.${key}`).toBe(false);
          expect(value.trim().length, `${locale}/${namespace}.${key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('never claims an integration that does not exist', () => {
    const forbidden =
      /\b(hubspot|pipedrive|salesforce|shopify|woocommerce|wolt|whatsapp|zapier)\b/i;
    for (const locale of LOCALES) {
      for (const namespace of [...NEW_NAMESPACES, 'marketing']) {
        for (const [key, value] of flatten(read(locale, namespace))) {
          expect(forbidden.test(value), `${locale}/${namespace}.${key}`).toBe(false);
        }
      }
    }
  });

  it('never publishes a price in a currency that has no price book', () => {
    const forbidden = /(€|\bEUR\b|\bUSD\b|\$\d)/;
    for (const locale of LOCALES) {
      for (const namespace of [...NEW_NAMESPACES, 'marketing']) {
        for (const [key, value] of flatten(read(locale, namespace))) {
          expect(forbidden.test(value), `${locale}/${namespace}.${key}`).toBe(false);
        }
      }
    }
  });

  it('never invents ratings, review counts or customer totals', () => {
    const forbidden =
      /\b(trusted by \d|\d+ ?\+? (customers|companies|businesses) (trust|use)|rated \d(\.\d)? ?\/ ?5|\d{2,}% (faster|cheaper|more))\b/i;
    for (const locale of LOCALES) {
      for (const namespace of NEW_NAMESPACES) {
        for (const [key, value] of flatten(read(locale, namespace))) {
          expect(forbidden.test(value), `${locale}/${namespace}.${key}`).toBe(false);
        }
      }
    }
  });

  it('keeps every collection slug addressable from its catalogue', () => {
    const collections: readonly (readonly [string, readonly ContentEntry[]])[] = [
      ['marketingIntegrations', INTEGRATIONS],
      ['marketingCompare', COMPARISONS],
    ];
    for (const [namespace, entries] of collections) {
      for (const locale of LOCALES) {
        const tree = read(locale, namespace);
        for (const entry of entries) {
          expect(at(tree, `${entry.id}.meta.title`), `${locale}/${namespace}/${entry.id}`).toBeTypeOf(
            'string',
          );
        }
      }
    }
  });
});
