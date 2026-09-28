import { describe, expect, it } from 'vitest';
import { PATHNAMES } from '../src/i18n/pathnames';
import { proxy } from '../src/proxy';

function request(path: string, cookie?: string): Request {
  return new Request(`https://velyric.com${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function call(path: string, cookie?: string) {
  const { NextRequest } = await import('next/server');
  return proxy(new NextRequest(request(path, cookie)));
}

describe('admin route boundary', () => {
  it('answers 404 for a visitor with no session instead of revealing the console', async () => {
    for (const path of ['/admin', '/admin/tenants', '/admin/staff']) {
      const response = await call(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('location'), path).toBeNull();
    }
  });

  it('never caches the console and always sends a script nonce', async () => {
    const response = await call('/admin/tenants', 'vly_session=token');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('Content-Security-Policy')).toContain("'nonce-");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('keeps the console out of locale handling', async () => {
    const response = await call('/admin', 'vly_session=token');
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('is not part of the public routing table', () => {
    expect(Object.keys(PATHNAMES).some((pathname) => pathname.startsWith('/admin'))).toBe(false);
  });
});
