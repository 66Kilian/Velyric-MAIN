import { describe, expect, it } from 'vitest';
import {
  COMPARISONS,
  GLOSSARY_TERMS,
  INTEGRATIONS,
  VERTICALS,
  type ContentEntry,
} from '@/content/collections';
import { allLocalePaths, sitePages } from '@/content/pages';
import { PATHNAMES } from '@/i18n/pathnames';
import { LOCALES } from '@/i18n/routing';
import { alternateLanguages, localizedPath, localizedUrls } from '@/lib/seo/urls';

const ORIGIN = 'https://velyric.com';
const COLLECTIONS: readonly (readonly [string, readonly ContentEntry[]])[] = [
  ['verticals', VERTICALS],
  ['integrations', INTEGRATIONS],
  ['comparisons', COMPARISONS],
  ['glossary', GLOSSARY_TERMS],
];

describe('content collections', () => {
  it('defines a slug for every locale in every entry', () => {
    for (const [name, entries] of COLLECTIONS) {
      for (const entry of entries) {
        for (const locale of LOCALES) {
          expect(entry.slugs[locale], `${name}/${entry.id}/${locale}`).toBeTruthy();
        }
      }
    }
  });

  it('uses url-safe lowercase slugs', () => {
    for (const [name, entries] of COLLECTIONS) {
      for (const entry of entries) {
        for (const locale of LOCALES) {
          expect(entry.slugs[locale], `${name}/${entry.id}/${locale}`).toMatch(
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          );
        }
      }
    }
  });

  it('keeps slugs unique inside each collection and locale', () => {
    for (const [name, entries] of COLLECTIONS) {
      for (const locale of LOCALES) {
        const slugs = entries.map((entry) => entry.slugs[locale]);
        expect(new Set(slugs).size, `${name}/${locale}`).toBe(slugs.length);
      }
    }
  });

  it('carries an ISO date for every entry', () => {
    for (const [, entries] of COLLECTIONS) {
      for (const entry of entries) {
        expect(entry.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
});

describe('localized paths', () => {
  it('prefixes every path with its locale and leaves no unresolved segments', () => {
    for (const page of sitePages()) {
      for (const locale of LOCALES) {
        const path = localizedPath(page.location, locale);
        expect(path.startsWith(`/${locale}`), `${page.id}/${locale}`).toBe(true);
        expect(path, `${page.id}/${locale}`).not.toMatch(/\[|\]/);
        expect(path, `${page.id}/${locale}`).not.toMatch(/\/\//);
        expect(path === `/${locale}` || !path.endsWith('/')).toBe(true);
      }
    }
  });

  it('produces a globally unique url for every page and locale', () => {
    const paths = allLocalePaths();
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('never emits uppercase characters in a path', () => {
    for (const path of allLocalePaths()) {
      expect(path).toBe(path.toLowerCase());
    }
  });

  it('builds reciprocal hreflang clusters with x-default pointing at english', () => {
    for (const page of sitePages()) {
      const languages = alternateLanguages(ORIGIN, page.location);
      for (const locale of LOCALES) {
        expect(languages[locale], `${page.id}/${locale}`).toBe(
          `${ORIGIN}${localizedPath(page.location, locale)}`,
        );
      }
      expect(languages['x-default']).toBe(languages['en']);
      expect(Object.keys(languages)).toHaveLength(LOCALES.length + 1);
    }
  });

  it('emits absolute urls rooted at the configured origin', () => {
    for (const page of sitePages()) {
      for (const url of Object.values(localizedUrls(ORIGIN, page.location))) {
        expect(url.startsWith(`${ORIGIN}/`)).toBe(true);
        expect(url).not.toContain('localhost');
        expect(url).not.toContain('127.0.0.1');
      }
    }
  });

  it('gives german and hungarian their own slugs on the primary commercial pages', () => {
    const differentiated = ['/product', '/ai-receptionist', '/appointment-booking', '/pricing'];
    for (const pathname of differentiated) {
      const entry = PATHNAMES[pathname as keyof typeof PATHNAMES];
      expect(typeof entry, pathname).toBe('object');
      if (typeof entry !== 'string') {
        expect(new Set([entry.en, entry.hu, entry.de]).size, pathname).toBe(3);
      }
    }
  });
});

describe('site page registry', () => {
  it('never exposes a private or authentication route', () => {
    for (const path of allLocalePaths()) {
      expect(path).not.toMatch(/\/(login|signup)$/);
      expect(path.startsWith('/app')).toBe(false);
      expect(path.startsWith('/internal')).toBe(false);
    }
  });

  it('covers every indexable pathname declared in the routing table', () => {
    const covered = new Set(sitePages().map((page) => page.location.pathname));
    // Account routes carry robots noindex, so they have no place in the sitemap.
    const accountRoutes = new Set(['/login', '/signup', '/invite/[tenant]/[id]']);
    const expected = Object.keys(PATHNAMES).filter((pathname) => !accountRoutes.has(pathname));
    for (const pathname of expected) {
      expect(covered.has(pathname as keyof typeof PATHNAMES), pathname).toBe(true);
    }
  });
});
