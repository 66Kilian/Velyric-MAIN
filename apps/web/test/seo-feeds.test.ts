import { describe, expect, it } from 'vitest';
import { sitePages } from '@/content/pages';
import { LOCALES } from '@/i18n/routing';
import { buildRobots, buildSitemap, PRIVATE_PATHS } from '@/lib/seo/feeds';

const ORIGIN = 'https://velyric.com';

describe('sitemap', () => {
  const entries = buildSitemap(ORIGIN);

  it('covers every registered page plus the legal documents', () => {
    expect(entries).toHaveLength(sitePages().length + 3);
  });

  it('uses absolute production urls only', () => {
    for (const entry of entries) {
      expect(entry.url.startsWith(`${ORIGIN}/`)).toBe(true);
      expect(entry.url).not.toContain('localhost');
      expect(entry.url).not.toContain('127.0.0.1');
      expect(entry.url).not.toContain('?');
      expect(entry.url).not.toContain('#');
    }
  });

  it('never lists a duplicate url', () => {
    const urls = entries.map((entry) => entry.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('never lists a private, auth or noindex route', () => {
    for (const entry of entries) {
      expect(entry.url).not.toMatch(/\/(login|signup)$/);
      expect(entry.url).not.toContain('/app/');
      expect(entry.url).not.toContain('/internal');
      expect(entry.url).not.toContain('/status');
      expect(entry.url).not.toContain('/og');
    }
  });

  it('carries a real content date rather than a build timestamp', () => {
    const today = new Date();
    for (const entry of entries) {
      const modified = entry.lastModified;
      expect(modified).toBeInstanceOf(Date);
      const value = modified as Date;
      expect(Number.isNaN(value.getTime())).toBe(false);
      expect(value.getTime()).toBeLessThanOrEqual(today.getTime() + 86_400_000);
    }
  });

  it('declares every locale plus x-default on localized entries', () => {
    for (const entry of entries.filter((item) => !item.url.includes('/legal/'))) {
      const languages = entry.alternates?.languages ?? {};
      for (const locale of LOCALES) {
        expect(Object.keys(languages), entry.url).toContain(locale);
      }
      expect(Object.keys(languages), entry.url).toContain('x-default');
    }
  });

  it('keeps priorities inside the valid range', () => {
    for (const entry of entries) {
      expect(entry.priority).toBeGreaterThan(0);
      expect(entry.priority).toBeLessThanOrEqual(1);
    }
  });
});

describe('robots', () => {
  it('blocks everything while the site is not meant to be indexed', () => {
    const robots = buildRobots(ORIGIN, false);
    const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    expect(rules[0]?.disallow).toBe('/');
    expect(robots.sitemap).toBeUndefined();
  });

  it('allows crawling and points at the sitemap in production', () => {
    const robots = buildRobots(ORIGIN, true);
    const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    expect(rules[0]?.userAgent).toBe('*');
    expect(rules[0]?.allow).toContain('/');
    expect(robots.sitemap).toBe(`${ORIGIN}/sitemap.xml`);
  });

  it('disallows every private surface for every declared agent', () => {
    const robots = buildRobots(ORIGIN, true);
    const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    for (const rule of rules) {
      expect(rule.disallow).toEqual(PRIVATE_PATHS);
      expect(rule.allow).toContain('/');
    }
    for (const path of ['/app/', '/app$', '/internal/', '/api/', '/v1/']) {
      expect(PRIVATE_PATHS).toContain(path);
    }
  });

  it('never blocks a public path by prefix and leaves noindex pages crawlable', () => {
    const blocked = (path: string): boolean =>
      PRIVATE_PATHS.some((rule) =>
        rule.endsWith('$') ? path === rule.slice(0, -1) : path.startsWith(rule),
      );
    for (const path of ['/apple-icon.png', '/hu/login', '/hu/signup', '/status', '/legal/terms']) {
      expect(blocked(path)).toBe(false);
    }
    for (const path of ['/app', '/app/workspace', '/api/auth/sign-in', '/v1/agents']) {
      expect(blocked(path)).toBe(true);
    }
  });

  it('states an explicit policy for ai search and training crawlers', () => {
    const robots = buildRobots(ORIGIN, true);
    const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    const agents = rules.map((rule) => rule.userAgent);
    for (const agent of [
      'OAI-SearchBot',
      'PerplexityBot',
      'ClaudeBot',
      'GPTBot',
      'Google-Extended',
    ]) {
      expect(agents).toContain(agent);
    }
  });
});
