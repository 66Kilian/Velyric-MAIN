import type { MetadataRoute } from 'next';
import { LEGAL_DOCUMENTS, pageUpdated, sitePages } from '@/content/pages';
import { DEFAULT_LOCALE } from '@/i18n/routing';
import { absoluteUrl, alternateLanguages, localizedPath } from './urls';

const LEGAL_UPDATED = '2026-09-01';

// Crawlers match these as prefixes, so every entry ends with a slash and the
// bare path is anchored with "$". Pages that merely should not rank (login,
// signup, status) stay crawlable and carry a noindex tag instead, otherwise
// crawlers cannot read that tag and may list the bare URL anyway.
export const PRIVATE_PATHS = [
  '/app/',
  '/app$',
  '/internal/',
  '/internal$',
  '/api/',
  '/v1/',
  '/not-found-page',
];

const AI_SEARCH_AGENTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'PerplexityBot',
  'ClaudeBot',
  'Claude-User',
];
const AI_TRAINING_AGENTS = ['GPTBot', 'Google-Extended', 'Applebot-Extended'];

export function buildSitemap(origin: string): MetadataRoute.Sitemap {
  const pages = sitePages().map((page) => ({
    url: absoluteUrl(origin, localizedPath(page.location, DEFAULT_LOCALE)),
    lastModified: new Date(page.updated),
    priority: page.priority,
    alternates: { languages: { ...alternateLanguages(origin, page.location) } },
  }));
  const legal = LEGAL_DOCUMENTS.map((document) => ({
    url: absoluteUrl(origin, `/legal/${document}`),
    lastModified: new Date(pageUpdated(`legal/${document}`, LEGAL_UPDATED)),
    priority: 0.3,
  }));
  return [...pages, ...legal];
}

export function buildRobots(origin: string, indexable: boolean): MetadataRoute.Robots {
  if (!indexable) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  const publicRule = (
    userAgent: string,
  ): { userAgent: string; allow: string[]; disallow: string[] } => ({
    userAgent,
    allow: ['/', '/og'],
    disallow: [...PRIVATE_PATHS],
  });
  return {
    rules: [
      publicRule('*'),
      ...AI_SEARCH_AGENTS.map((userAgent) => publicRule(userAgent)),
      ...AI_TRAINING_AGENTS.map((userAgent) => publicRule(userAgent)),
    ],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
