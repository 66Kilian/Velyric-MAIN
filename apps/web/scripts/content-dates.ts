import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPARISONS, GLOSSARY_TERMS, INTEGRATIONS, VERTICALS } from '../src/content/collections';
import { LEGAL_DOCUMENTS } from '../src/content/pages';
import { LOCALES } from '../src/i18n/routing';

const here = path.dirname(fileURLToPath(import.meta.url));
const messagesDir = path.resolve(here, '../../../packages/i18n/messages');
const outFile = path.resolve(here, '../src/content/page-dates.json');
const check = process.argv.includes('--check');

type Tree = { readonly [key: string]: unknown };

const catalogs = new Map<string, Tree>();

function catalog(locale: string, namespace: string): Tree {
  const key = `${locale}/${namespace}`;
  const cached = catalogs.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = JSON.parse(
    readFileSync(path.join(messagesDir, locale, `${namespace}.json`), 'utf8'),
  ) as Tree;
  catalogs.set(key, parsed);
  return parsed;
}

function select(locale: string, pointer: string): unknown {
  const [namespace, ...rest] = pointer.split('.');
  let node: unknown = catalog(locale, namespace ?? '');
  for (const key of rest) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`${pointer} is missing from the ${locale} catalog`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  if (node === undefined) {
    throw new Error(`${pointer} is missing from the ${locale} catalog`);
  }
  return node;
}

// The text every page is built from. A page counts as updated when this content
// changes, which is what the sitemap reports to crawlers as its last change.
const HOME_SECTIONS = [
  'meta',
  'hero',
  'proof',
  'features',
  'command',
  'showcase',
  'integrations',
  'pricing',
  'trust',
  'cta',
];

function pageSources(): ReadonlyMap<string, readonly string[]> {
  const sources = new Map<string, readonly string[]>([
    ['/', HOME_SECTIONS.map((section) => `marketing.${section}`)],
    ['/product', ['marketing.productPage']],
    ['/ai-receptionist', ['marketingCapabilities.receptionist', 'marketingCapabilities.common']],
    ['/appointment-booking', ['marketingCapabilities.booking', 'marketingCapabilities.common']],
    ['/multilingual', ['marketingCapabilities.multilingual', 'marketingCapabilities.common']],
    ['/call-transfer', ['marketingCapabilities.transfer', 'marketingCapabilities.common']],
    ['/pricing', ['marketing.pricingPage', 'marketing.pricing']],
    ['/integrations', ['marketing.integrationsPage', 'marketingIntegrations.hub']],
    ['/security', ['marketing.securityPage']],
    ['/docs', ['marketing.docsPage']],
    ['/glossary', ['marketingGlossary.hub', 'marketingGlossary.terms']],
    ['/contact', ['marketingContact']],
  ]);
  for (const entry of VERTICALS) {
    sources.set(`solutions/${entry.id}`, [
      `marketing.solutions.${entry.id}`,
      'marketing.solutions.common',
    ]);
  }
  for (const entry of INTEGRATIONS) {
    sources.set(`integrations/${entry.id}`, [
      `marketingIntegrations.${entry.id}`,
      'marketingIntegrations.common',
    ]);
  }
  for (const entry of COMPARISONS) {
    sources.set(`compare/${entry.id}`, [`marketingCompare.${entry.id}`, 'marketingCompare.common']);
  }
  for (const entry of GLOSSARY_TERMS) {
    sources.set(`glossary/${entry.id}`, [
      `marketingGlossary.terms.${entry.id}`,
      'marketingGlossary.labels',
    ]);
  }
  for (const document of LEGAL_DOCUMENTS) {
    sources.set(`legal/${document}`, [`legal.${document}`, 'legal.operator']);
  }
  return sources;
}

function fingerprint(pointers: readonly string[]): string {
  const hash = createHash('sha256');
  for (const locale of LOCALES) {
    for (const pointer of pointers) {
      hash.update(`${locale}:${pointer}:${JSON.stringify(select(locale, pointer))}|`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

interface PageDate {
  readonly hash: string;
  readonly updated: string;
}

function read(): Record<string, PageDate> {
  try {
    return JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, PageDate>;
  } catch {
    return {};
  }
}

const today = new Date().toISOString().slice(0, 10);
const previous = read();
const next: Record<string, PageDate> = {};
const changed: string[] = [];
for (const [id, pointers] of [...pageSources()].sort(([a], [b]) => a.localeCompare(b))) {
  const hash = fingerprint(pointers);
  const before = previous[id];
  if (before !== undefined && before.hash === hash) {
    next[id] = before;
    continue;
  }
  next[id] = { hash, updated: today };
  changed.push(id);
}
for (const id of Object.keys(previous)) {
  if (next[id] === undefined) {
    changed.push(`${id} (removed)`);
  }
}

const serialized = `${JSON.stringify(next, null, 2)}\n`;
if (check) {
  if (changed.length > 0) {
    process.stderr.write(
      `page dates are stale, run "pnpm --filter @velyric/web content:dates": ${changed.join(', ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`page dates are current (${String(Object.keys(next).length)} pages)\n`);
} else {
  writeFileSync(outFile, serialized, 'utf8');
  process.stdout.write(
    changed.length === 0
      ? `page dates unchanged (${String(Object.keys(next).length)} pages)\n`
      : `page dates updated to ${today}: ${changed.join(', ')}\n`,
  );
}
