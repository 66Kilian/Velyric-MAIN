import { Locale } from '@velyric/contracts';

export const LOCALES: readonly Locale[] = Object.freeze([Locale.HU, Locale.DE, Locale.EN]);

export const DEFAULT_LOCALE: Locale = Locale.EN;

export const LOCALE_COOKIE_NAME = 'velyric_locale';

export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const GEO_COUNTRY_HEADER = 'cf-ipcountry';

const COUNTRY_LOCALES: Readonly<Record<string, Locale>> = Object.freeze({
  HU: Locale.HU,
  DE: Locale.DE,
  AT: Locale.DE,
  CH: Locale.DE,
  LI: Locale.DE,
});

const NON_GEOGRAPHIC_COUNTRY_CODES: ReadonlySet<string> = new Set([
  'XX',
  'T1',
  'EU',
  'AP',
  'A1',
  'A2',
  'O1',
  'ZZ',
]);

export type LocaleSource = 'url' | 'account' | 'cookie' | 'geo' | 'accept-language' | 'default';

export interface LocaleResolutionInput {
  readonly urlLocale?: string | null | undefined;
  readonly accountLocale?: string | null | undefined;
  readonly cookieLocale?: string | null | undefined;
  readonly country?: string | null | undefined;
  readonly acceptLanguage?: string | null | undefined;
}

export interface LocaleResolution {
  readonly locale: Locale;
  readonly source: LocaleSource;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

function normalizedLocale(value: string | null | undefined): Locale | null {
  if (value === null || value === undefined) {
    return null;
  }
  const candidate = value.trim().toLowerCase();
  return isLocale(candidate) ? candidate : null;
}

export function localeFromCountry(country: string | null | undefined): Locale | null {
  if (country === null || country === undefined) {
    return null;
  }
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || NON_GEOGRAPHIC_COUNTRY_CODES.has(code)) {
    return null;
  }
  return COUNTRY_LOCALES[code] ?? Locale.EN;
}

export interface AcceptLanguageEntry {
  readonly tag: string;
  readonly quality: number;
}

function isLanguageRange(tag: string): boolean {
  if (tag === '*') {
    return true;
  }
  const [primary, ...subtags] = tag.split('-');
  return (
    primary !== undefined &&
    /^[a-z]{1,8}$/.test(primary) &&
    subtags.every((subtag) => /^[a-z0-9]{1,8}$/.test(subtag))
  );
}

export function parseAcceptLanguage(header: string | null | undefined): AcceptLanguageEntry[] {
  if (header === null || header === undefined) {
    return [];
  }
  const entries: { tag: string; quality: number; order: number }[] = [];
  header.split(',').forEach((part, order) => {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = rawTag?.trim().toLowerCase() ?? '';
    if (!isLanguageRange(tag)) {
      return;
    }
    let quality = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key?.trim().toLowerCase() === 'q' && value !== undefined) {
        const parsed = Number(value.trim());
        quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      }
    }
    if (quality > 0) {
      entries.push({ tag, quality, order });
    }
  });
  return entries
    .sort((left, right) => right.quality - left.quality || left.order - right.order)
    .map(({ tag, quality }) => ({ tag, quality }));
}

export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  for (const entry of parseAcceptLanguage(header)) {
    const primary = entry.tag.split('-')[0];
    if (isLocale(primary)) {
      return primary;
    }
  }
  return null;
}

export function resolveLocale(input: LocaleResolutionInput): LocaleResolution {
  const urlLocale = normalizedLocale(input.urlLocale);
  if (urlLocale !== null) {
    return { locale: urlLocale, source: 'url' };
  }
  const accountLocale = normalizedLocale(input.accountLocale);
  if (accountLocale !== null) {
    return { locale: accountLocale, source: 'account' };
  }
  const cookieLocale = normalizedLocale(input.cookieLocale);
  if (cookieLocale !== null) {
    return { locale: cookieLocale, source: 'cookie' };
  }
  const geoLocale = localeFromCountry(input.country);
  if (geoLocale !== null) {
    return { locale: geoLocale, source: 'geo' };
  }
  const acceptLocale = localeFromAcceptLanguage(input.acceptLanguage);
  if (acceptLocale !== null) {
    return { locale: acceptLocale, source: 'accept-language' };
  }
  return { locale: DEFAULT_LOCALE, source: 'default' };
}

export function isExplicitLocaleSource(source: LocaleSource): boolean {
  return source === 'url' || source === 'account' || source === 'cookie';
}

export function localeCookieUpdate(
  resolution: LocaleResolution,
  currentCookie: string | null | undefined,
): Locale | null {
  const current = normalizedLocale(currentCookie);
  if (current === resolution.locale) {
    return null;
  }
  if (current !== null && !isExplicitLocaleSource(resolution.source)) {
    return null;
  }
  return resolution.locale;
}

export function localeFromPathname(pathname: string): Locale | null {
  const segment = pathname.split('/')[1];
  return isLocale(segment) ? segment : null;
}

export function stripLocaleFromPathname(pathname: string): string {
  const locale = localeFromPathname(pathname);
  if (locale === null) {
    return pathname;
  }
  const rest = pathname.slice(locale.length + 1);
  return rest === '' ? '/' : rest;
}

export function localizedPathname(locale: Locale, pathname: string): string {
  const bare = stripLocaleFromPathname(pathname);
  return bare === '/' ? `/${locale}` : `/${locale}${bare}`;
}
