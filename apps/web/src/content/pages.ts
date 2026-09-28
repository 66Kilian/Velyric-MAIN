import type { AppPathname } from '@/i18n/pathnames';
import { LOCALES, type AppLocale } from '@/i18n/routing';
import { entryLocation, localizedPath, staticLocation, type PageLocation } from '@/lib/seo/urls';
import { COMPARISONS, GLOSSARY_TERMS, INTEGRATIONS, VERTICALS } from './collections';
import pageDates from './page-dates.json';

export interface SitePage {
  readonly id: string;
  readonly location: PageLocation;
  readonly priority: number;
  readonly updated: string;
  readonly parent: AppPathname | null;
}

const FALLBACK_UPDATED = '2026-09-16';

// Written by scripts/content-dates.ts: the date a page's own text last changed,
// so the sitemap reports real freshness instead of one build-wide constant.
export function pageUpdated(id: string, fallback = FALLBACK_UPDATED): string {
  return (
    (pageDates as Record<string, { hash: string; updated: string } | undefined>)[id]?.updated ??
    fallback
  );
}

const STATIC_PAGES: readonly {
  readonly pathname: AppPathname;
  readonly priority: number;
  readonly parent: AppPathname | null;
}[] = [
  { pathname: '/', priority: 1, parent: null },
  { pathname: '/product', priority: 0.9, parent: null },
  { pathname: '/ai-receptionist', priority: 0.9, parent: '/product' },
  { pathname: '/appointment-booking', priority: 0.9, parent: '/product' },
  { pathname: '/multilingual', priority: 0.8, parent: '/product' },
  { pathname: '/call-transfer', priority: 0.8, parent: '/product' },
  { pathname: '/pricing', priority: 0.9, parent: null },
  { pathname: '/integrations', priority: 0.8, parent: null },
  { pathname: '/security', priority: 0.7, parent: null },
  { pathname: '/docs', priority: 0.7, parent: null },
  { pathname: '/glossary', priority: 0.6, parent: null },
  { pathname: '/contact', priority: 0.6, parent: null },
];

export function sitePages(): readonly SitePage[] {
  const statics: SitePage[] = STATIC_PAGES.map((page) => ({
    id: page.pathname,
    location: staticLocation(page.pathname),
    priority: page.priority,
    updated: pageUpdated(page.pathname),
    parent: page.parent,
  }));
  const verticals: SitePage[] = VERTICALS.map((entry) => ({
    id: `solutions/${entry.id}`,
    location: entryLocation('/solutions/[vertical]', 'vertical', entry),
    priority: 0.8,
    updated: pageUpdated(`solutions/${entry.id}`, entry.updated),
    parent: '/product',
  }));
  const integrations: SitePage[] = INTEGRATIONS.map((entry) => ({
    id: `integrations/${entry.id}`,
    location: entryLocation('/integrations/[integration]', 'integration', entry),
    priority: 0.7,
    updated: pageUpdated(`integrations/${entry.id}`, entry.updated),
    parent: '/integrations',
  }));
  const comparisons: SitePage[] = COMPARISONS.map((entry) => ({
    id: `compare/${entry.id}`,
    location: entryLocation('/compare/[comparison]', 'comparison', entry),
    priority: 0.6,
    updated: pageUpdated(`compare/${entry.id}`, entry.updated),
    parent: '/product',
  }));
  const glossary: SitePage[] = GLOSSARY_TERMS.map((entry) => ({
    id: `glossary/${entry.id}`,
    location: entryLocation('/glossary/[term]', 'term', entry),
    priority: 0.5,
    updated: pageUpdated(`glossary/${entry.id}`, entry.updated),
    parent: '/glossary',
  }));
  return [...statics, ...verticals, ...integrations, ...comparisons, ...glossary];
}

export const LEGAL_DOCUMENTS = ['privacy', 'terms', 'dpa'] as const;

export function allLocalePaths(): readonly string[] {
  return sitePages().flatMap((page) =>
    LOCALES.map((locale: AppLocale) => localizedPath(page.location, locale)),
  );
}
