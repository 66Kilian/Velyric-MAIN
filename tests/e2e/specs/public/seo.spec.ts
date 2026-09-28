import { expect, test, type Page } from '@playwright/test';
import { LOCALES } from '../../fixtures/messages.js';
import { indexablePaths, localizedPath, type PublicLocale } from '../../fixtures/routes.js';

const SECRET_PATTERNS = [
  'OPENAI_API_KEY',
  'TELNYX_API_KEY',
  'STRIPE_SECRET',
  'DATABASE_URL',
  'API_SECRET',
  'sk-',
  'BEGIN PRIVATE KEY',
];

async function attribute(page: Page, selector: string, name: string): Promise<string | null> {
  const locator = page.locator(selector).first();
  return (await locator.count()) === 0 ? null : locator.getAttribute(name);
}

async function sitemapUrls(page: Page): Promise<readonly string[]> {
  const response = await page.request.get('/sitemap.xml');
  expect(response.status()).toBe(200);
  const body = await response.text();
  return [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? '');
}

test('robots.txt allows crawling and advertises the sitemap', async ({ page }) => {
  const response = await page.request.get('/robots.txt');
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toContain('Sitemap:');
  expect(body).toContain('Disallow: /app');
  expect(body).toContain('Disallow: /*/login');
  expect(body).not.toMatch(/^User-Agent: \*\nDisallow: \/$/m);
});

test('sitemap lists only reachable, canonical, non-private urls', async ({ page }) => {
  const urls = await sitemapUrls(page);
  expect(urls.length).toBeGreaterThan(20);
  expect(new Set(urls).size).toBe(urls.length);
  for (const url of urls) {
    expect(url).not.toContain('/login');
    expect(url).not.toContain('/signup');
    expect(url).not.toContain('/app/');
    expect(url).not.toContain('/status');
  }
  for (const url of urls.slice(0, 24)) {
    const path = new URL(url).pathname;
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
  }
});

test('every sitemap entry declares reciprocal hreflang alternates', async ({ page }) => {
  const response = await page.request.get('/sitemap.xml');
  const body = await response.text();
  const blocks = body.split('<url>').slice(1);
  for (const block of blocks.filter((entry) => !entry.includes('/legal/'))) {
    for (const locale of LOCALES) {
      expect(block).toContain(`hreflang="${locale}"`);
    }
    expect(block).toContain('hreflang="x-default"');
  }
});

for (const locale of LOCALES) {
  test(`indexable pages expose complete metadata (${locale})`, async ({ page }) => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const path of indexablePaths(locale as PublicLocale)) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);

      const title = await page.title();
      expect(title.length, `${path} title`).toBeGreaterThan(10);
      expect(title.length, `${path} title`).toBeLessThanOrEqual(75);
      expect(titles.has(title), `${path} duplicate title`).toBe(false);
      titles.add(title);

      const description = await attribute(page, 'meta[name="description"]', 'content');
      expect(description, `${path} description`).not.toBeNull();
      expect((description ?? '').length, `${path} description`).toBeGreaterThan(50);
      expect(descriptions.has(description ?? ''), `${path} duplicate description`).toBe(false);
      descriptions.add(description ?? '');

      const canonical = await attribute(page, 'link[rel="canonical"]', 'href');
      expect(canonical, `${path} canonical`).not.toBeNull();
      expect(new URL(canonical ?? '').pathname, `${path} canonical`).toBe(path);

      for (const alternate of LOCALES) {
        const href = await attribute(
          page,
          `link[rel="alternate"][hreflang="${alternate}"]`,
          'href',
        );
        expect(href, `${path} hreflang ${alternate}`).not.toBeNull();
      }
      expect(
        await attribute(page, 'link[rel="alternate"][hreflang="x-default"]', 'href'),
        `${path} x-default`,
      ).not.toBeNull();

      expect(await attribute(page, 'meta[property="og:title"]', 'content')).toBeTruthy();
      expect(await attribute(page, 'meta[property="og:image"]', 'content')).toBeTruthy();
      expect(await attribute(page, 'meta[name="twitter:card"]', 'content')).toBe(
        'summary_large_image',
      );

      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      expect(await page.locator('meta[name="robots"][content*="noindex"]').count(), path).toBe(0);
    }
  });
}

test('authentication pages are excluded from the index', async ({ page }) => {
  for (const key of ['login', 'signup'] as const) {
    await page.goto(localizedPath(key, 'en'));
    const robots = await attribute(page, 'meta[name="robots"]', 'content');
    expect(robots, key).toContain('noindex');
  }
});

test('structured data parses and stays free of fabricated trust signals', async ({ page }) => {
  await page.goto(localizedPath('home', 'en'));
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(blocks.length).toBeGreaterThan(0);
  const types = new Set<string>();
  for (const block of blocks) {
    const parsed: unknown = JSON.parse(block);
    expect(parsed).toBeTruthy();
    const graph = (parsed as { '@graph'?: readonly { '@type'?: string }[] })['@graph'] ?? [];
    for (const node of graph) {
      if (typeof node['@type'] === 'string') {
        types.add(node['@type']);
      }
    }
    expect(block).not.toContain('AggregateRating');
    expect(block).not.toContain('ratingValue');
    expect(block).not.toContain('reviewCount');
  }
  expect(types).toContain('Organization');
  expect(types).toContain('WebSite');
  expect(types).toContain('SoftwareApplication');
});

test('pricing publishes offer data that matches the visible plans', async ({ page }) => {
  await page.goto(localizedPath('pricing', 'en'));
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const serialized = blocks.join('');
  expect(serialized).toContain('SoftwareApplication');
  expect(serialized).toContain('HUF');
  expect(serialized).toContain('FAQPage');
});

test('public html never contains secret-looking material', async ({ page }) => {
  for (const path of [localizedPath('home', 'en'), localizedPath('pricing', 'en')]) {
    await page.goto(path);
    const html = await page.content();
    for (const pattern of SECRET_PATTERNS) {
      expect(html.includes(pattern), `${path} contains ${pattern}`).toBe(false);
    }
  }
});

test('old marketing urls redirect permanently to their localized replacements', async ({
  page,
}) => {
  const moved: readonly (readonly [string, string])[] = [
    ['/de/product', '/de/ki-telefonassistent'],
    ['/hu/pricing', '/hu/arak'],
    ['/en/product', '/en/ai-voice-agents'],
    ['/en/solutions/dental-clinic', '/en/solutions/dental-clinics'],
  ];
  for (const [from, to] of moved) {
    const response = await page.request.get(from, { maxRedirects: 0 });
    expect(response.status(), from).toBe(308);
    expect(response.headers()['location'], from).toContain(to);
  }
});

test('framework scripts carry the csp nonce so the page can hydrate', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (entry) => {
    if (entry.text().includes('Content Security Policy')) {
      violations.push(entry.text());
    }
  });
  await page.goto(localizedPath('home', 'en'));
  const scripts = page.locator('script[src]');
  const count = await scripts.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const src = await scripts.nth(index).getAttribute('src');
    if (src !== null && src.startsWith('/_next/')) {
      expect(await scripts.nth(index).getAttribute('nonce'), src).not.toBeNull();
    }
  }
  expect(violations).toEqual([]);
});
