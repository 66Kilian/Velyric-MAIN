import { localeFromPathname, resolveLocale } from '@velyric/i18n';
import createIntlMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { PATHNAMES } from './i18n/pathnames';
import { isAppLocale, LOCALE_COOKIE, routing, type AppLocale } from './i18n/routing';

const intl = createIntlMiddleware(routing);
const INTL_LOCALE_HEADER = 'x-next-intl-locale';
const LOCALE_NEUTRAL_PREFIXES = ['/admin', '/app', '/internal', '/legal', '/status', '/og'];
const PARAM = /^\[[a-z]+\]$/;

// Every page also answers on its English template path (/hu/pricing). Search
// engines should only keep the localized address, so those are answered with a
// permanent redirect before the locale middleware rewrites anything.
const CANONICAL_ALIASES: readonly {
  readonly locale: AppLocale;
  readonly template: readonly string[];
  readonly alias: readonly string[];
}[] = Object.entries(PATHNAMES).flatMap(([template, localized]) =>
  typeof localized === 'string'
    ? []
    : Object.entries(localized)
        .filter(([locale, alias]) => isAppLocale(locale) && alias !== template)
        .map(([locale, alias]) => ({
          locale: locale as AppLocale,
          template: template.split('/'),
          alias: alias.split('/'),
        })),
);

function canonicalPath(locale: AppLocale, pathname: string): string | null {
  const segments = pathname.split('/');
  for (const entry of CANONICAL_ALIASES) {
    if (entry.locale !== locale || entry.template.length !== segments.length) {
      continue;
    }
    const params: string[] = [];
    const matches = entry.template.every((part, index) => {
      const segment = segments[index] ?? '';
      if (!PARAM.test(part)) {
        return part === segment;
      }
      if (segment === '') {
        return false;
      }
      params.push(segment);
      return true;
    });
    if (matches) {
      let index = 0;
      return entry.alias
        .map((part) => {
          if (!PARAM.test(part)) {
            return part;
          }
          const value = params[index] ?? '';
          index += 1;
          return value;
        })
        .join('/');
    }
  }
  return null;
}
const SESSION_COOKIE_NAME = 'vly_session';

function nonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function csrfCookieName(): string {
  return process.env['VELYRIC_ENV'] === 'staging' || process.env['VELYRIC_ENV'] === 'production'
    ? '__Host-vly_csrf'
    : 'vly_csrf';
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

// Signed-in surfaces get a per-request nonce. Public pages must stay byte for
// byte identical so a CDN can cache them, so they rely on the same policy minus
// the nonce; they render no user input and hold no session data.
function contentSecurityPolicy(scriptNonce: string | null): string {
  const deployed =
    process.env['VELYRIC_ENV'] === 'staging' || process.env['VELYRIC_ENV'] === 'production';
  // strict-dynamic (the signed-in branch) makes any host allowlist on
  // script-src moot, so the Turnstile script host only needs to be listed on
  // the public, no-nonce branch where /signup actually renders the widget.
  const scriptSrc =
    scriptNonce === null
      ? `script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://challenges.cloudflare.com${deployed ? '' : " 'unsafe-eval'"}`
      : `script-src 'self' 'nonce-${scriptNonce}' 'strict-dynamic'${deployed ? '' : " 'unsafe-eval'"}`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' https://*.s3.${process.env['VELYRIC_AWS_REGION'] ?? 'eu-central-1'}.amazonaws.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://api.openai.com https://challenges.cloudflare.com${deployed ? '' : ' ws: http://127.0.0.1:* http://localhost:*'}`,
    "media-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "form-action 'self' https://checkout.stripe.com",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

function securityHeaders(response: NextResponse, csp: string): NextResponse {
  const deployed =
    process.env['VELYRIC_ENV'] === 'staging' || process.env['VELYRIC_ENV'] === 'production';
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), geolocation=(), microphone=(self), payment=(), usb=()',
  );
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  if (deployed) {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }
  return response;
}

function ensureCsrfCookie(request: NextRequest, response: NextResponse): NextResponse {
  const name = csrfCookieName();
  if (request.cookies.get(name) === undefined) {
    response.cookies.set(name, randomToken(), {
      path: '/',
      sameSite: 'strict',
      secure: name.startsWith('__Host-'),
      httpOnly: false,
      maxAge: 60 * 60 * 12,
    });
  }
  return response;
}

function withNonce(request: NextRequest, scriptNonce: string | null, csp: string): Headers {
  const headers = new Headers(request.headers);
  if (scriptNonce === null) {
    headers.delete('x-nonce');
  } else {
    headers.set('x-nonce', scriptNonce);
  }
  headers.set('content-security-policy', csp);
  return headers;
}

const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400';
const PRIVATE_PREFIXES = ['/admin', '/app', '/internal'];
const UNCACHED_PAGES = ['/login', '/signup', '/status', '/invite'];

function isPrivatePath(pathname: string): boolean {
  return PRIVATE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

// Pages a CDN may keep: no cookies, no session, the same markup for everyone.
function isCacheable(pathname: string): boolean {
  if (isPrivatePath(pathname)) {
    return false;
  }
  const locale = localeFromPathname(pathname);
  const withinLocale = locale === null ? pathname : pathname.slice(locale.length + 1) || '/';
  return !UNCACHED_PAGES.some(
    (page) => withinLocale === page || withinLocale.startsWith(`${page}/`),
  );
}

function cacheHeaders(response: NextResponse, cacheable: boolean): NextResponse {
  response.headers.set(
    'Cache-Control',
    cacheable ? PUBLIC_CACHE_CONTROL : 'private, no-store, max-age=0',
  );
  return response;
}

function varyOnNegotiation(response: NextResponse): NextResponse {
  response.headers.set('Vary', 'Accept-Language, Cookie, Sec-CH-Prefers-Color-Scheme');
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const cacheable = isCacheable(pathname);
  const scriptNonce = isPrivatePath(pathname) ? nonce() : null;
  const csp = contentSecurityPolicy(scriptNonce);

  if (
    pathname.startsWith('/admin') ||
    pathname.startsWith('/internal/support') ||
    pathname.startsWith('/app')
  ) {
    const hasSession = request.cookies.get(SESSION_COOKIE_NAME) !== undefined;
    if (!hasSession && !pathname.startsWith('/app')) {
      return securityHeaders(
        NextResponse.rewrite(new URL('/not-found-page', request.url), {
          status: 404,
          request: { headers: withNonce(request, scriptNonce, csp) },
        }),
        csp,
      );
    }
    if (!hasSession) {
      const resolved = resolveLocale({
        cookieLocale: request.cookies.get(LOCALE_COOKIE)?.value,
        country: request.headers.get('cf-ipcountry'),
        acceptLanguage: request.headers.get('accept-language'),
      });
      const login = new URL(`/${resolved.locale}/login`, request.url);
      login.searchParams.set('return_to', `${pathname}${search}`);
      return securityHeaders(NextResponse.redirect(login, 307), csp);
    }
    const response = NextResponse.next({
      request: { headers: withNonce(request, scriptNonce, csp) },
    });
    return cacheHeaders(securityHeaders(ensureCsrfCookie(request, response), csp), false);
  }

  // A production build runs the middleware again for the path the locale
  // middleware rewrote to. Canonicalising that internal path would redirect the
  // caller back to the localized one forever, so the second pass only renders.
  if (request.headers.get(INTL_LOCALE_HEADER) !== null) {
    return cacheHeaders(
      securityHeaders(
        NextResponse.next({ request: { headers: withNonce(request, scriptNonce, csp) } }),
        csp,
      ),
      cacheable,
    );
  }

  if (
    LOCALE_NEUTRAL_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return cacheHeaders(
      securityHeaders(
        NextResponse.next({ request: { headers: withNonce(request, scriptNonce, csp) } }),
        csp,
      ),
      cacheable,
    );
  }

  if (localeFromPathname(pathname) === null) {
    const resolved = resolveLocale({
      cookieLocale: request.cookies.get(LOCALE_COOKIE)?.value,
      country: request.headers.get('cf-ipcountry'),
      acceptLanguage: request.headers.get('accept-language'),
    });
    const target = new URL(
      `/${resolved.locale}${pathname === '/' ? '' : pathname}${search}`,
      request.url,
    );
    return varyOnNegotiation(securityHeaders(NextResponse.redirect(target, 307), csp));
  }

  const locale = localeFromPathname(pathname);
  const withinLocale = locale === null ? null : pathname.slice(locale.length + 1) || '/';
  const canonical =
    locale === null || withinLocale === null || !isAppLocale(locale)
      ? null
      : canonicalPath(locale, withinLocale);
  if (canonical !== null) {
    const target = new URL(`/${locale}${canonical}${search}`, request.url);
    return varyOnNegotiation(securityHeaders(NextResponse.redirect(target, 308), csp));
  }

  const intlResponse = intl(
    new NextRequest(request.url, { headers: withNonce(request, scriptNonce, csp) }),
  );
  return cacheHeaders(
    securityHeaders(cacheable ? intlResponse : ensureCsrfCookie(request, intlResponse), csp),
    cacheable,
  );
}

export const config = {
  matcher: ['/((?!_next|api|v1|.*\\..*).*)'],
};
