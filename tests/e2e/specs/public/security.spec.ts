import { expect, test } from '@playwright/test';

test.describe('edge security behaviour', () => {
  test('marketing responses carry hardened headers with a per-request CSP nonce', async ({
    request,
  }) => {
    const first = await request.get('/en', { maxRedirects: 0 });
    const second = await request.get('/en', { maxRedirects: 0 });
    expect(first.status()).toBe(200);
    const headers = first.headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toContain('microphone=(self)');
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    const nextNonce = /'nonce-([^']+)'/.exec(
      second.headers()['content-security-policy'] ?? '',
    )?.[1];
    expect(nonce).toBeDefined();
    expect(nextNonce).toBeDefined();
    expect(nonce).not.toBe(nextNonce);
  });

  test('root redirects to a negotiated locale', async ({ request }) => {
    const hungarian = await request.get('/', {
      maxRedirects: 0,
      headers: { 'accept-language': 'hu-HU,hu;q=0.9' },
    });
    expect(hungarian.status()).toBe(307);
    expect(new URL(hungarian.headers()['location'] ?? '', 'http://x.invalid').pathname).toBe('/hu');
    const german = await request.get('/pricing?ref=e2e', {
      maxRedirects: 0,
      headers: { 'accept-language': 'de-AT' },
    });
    expect(german.status()).toBe(307);
    const location = new URL(german.headers()['location'] ?? '', 'http://x.invalid');
    expect(location.pathname).toBe('/de/pricing');
    expect(location.searchParams.get('ref')).toBe('e2e');
  });

  test('locale cookie wins over accept-language', async ({ request }) => {
    const response = await request.get('/', {
      maxRedirects: 0,
      headers: { 'accept-language': 'de-DE', cookie: 'NEXT_LOCALE=en' },
    });
    expect(response.status()).toBe(307);
    expect(new URL(response.headers()['location'] ?? '', 'http://x.invalid').pathname).toBe('/en');
  });

  test('anonymous dashboard access redirects to login with the original path', async ({
    request,
  }) => {
    const response = await request.get('/app/00000000-0000-7000-8000-000000000000/calls?page=2', {
      maxRedirects: 0,
      headers: { 'accept-language': 'en' },
    });
    expect(response.status()).toBe(307);
    const location = new URL(response.headers()['location'] ?? '', 'http://x.invalid');
    expect(location.pathname).toBe('/en/login');
    expect(location.searchParams.get('return_to')).toBe(
      '/app/00000000-0000-7000-8000-000000000000/calls?page=2',
    );
  });

  test('internal support console is invisible to anonymous visitors', async ({ request }) => {
    const response = await request.get('/internal/support', { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  test('marketing pages issue a readable double-submit CSRF cookie', async ({ page, context }) => {
    await page.goto('/en');
    const cookies = await context.cookies();
    const csrf = cookies.find(
      (cookie) => cookie.name === 'vly_csrf' || cookie.name === '__Host-vly_csrf',
    );
    expect(csrf).toBeDefined();
    expect(csrf?.httpOnly).toBe(false);
    expect(csrf?.sameSite).toBe('Strict');
    expect(csrf?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('health endpoints answer without authentication', async ({ request }) => {
    const live = await request.get('/api/healthz/live');
    expect(live.status()).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await request.get('/api/healthz/ready');
    expect([200, 503]).toContain(ready.status());
    const body = (await ready.json()) as { status: string; control_api: boolean };
    expect(body.control_api).toBe(ready.status() === 200);
  });

  test('robots and sitemap are served', async ({ request }) => {
    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toMatch(/sitemap/i);
    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
    const xml = await sitemap.text();
    for (const locale of ['hu', 'de', 'en']) {
      expect(xml).toContain(`/${locale}/pricing`);
    }
  });
});
