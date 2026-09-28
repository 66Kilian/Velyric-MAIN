import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LOCALES = ['hu', 'de', 'en'] as const;
export type E2eLocale = (typeof LOCALES)[number];

const messagesRoot = fileURLToPath(new URL('../../../packages/i18n/messages/', import.meta.url));
const cache = new Map<string, unknown>();

function namespace(locale: E2eLocale, name: string): unknown {
  const key = `${locale}/${name}`;
  if (!cache.has(key)) {
    cache.set(key, JSON.parse(readFileSync(`${messagesRoot}${key}.json`, 'utf8')) as unknown);
  }
  return cache.get(key);
}

export function message(locale: E2eLocale, path: string): string {
  const [name, ...segments] = path.split('.');
  if (name === undefined || segments.length === 0) {
    throw new RangeError(`message path must include a namespace: ${path}`);
  }
  let node = namespace(locale, name);
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null || !(segment in node)) {
      throw new RangeError(`missing message ${locale}:${path}`);
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'string') {
    throw new TypeError(`message ${locale}:${path} is not a string`);
  }
  return node;
}

export function plain(text: string): string {
  return text.replace(/<\/?[a-zA-Z]+>/g, '').replace(/\{[^}]+\}/g, '');
}
