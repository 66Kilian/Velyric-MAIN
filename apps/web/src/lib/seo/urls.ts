import { PATHNAMES, type AppPathname } from '@/i18n/pathnames';
import { DEFAULT_LOCALE, LOCALES, type AppLocale } from '@/i18n/routing';
import type { ContentEntry } from '@/content/collections';

export type RouteParams = Readonly<Record<string, string>>;

export interface PageLocation {
  readonly pathname: AppPathname;
  readonly params?: Readonly<Record<AppLocale, RouteParams>>;
}

const SEGMENT = /\[([A-Za-z0-9_]+)\]/g;

export function localizedPath(location: PageLocation, locale: AppLocale): string {
  const template = PATHNAMES[location.pathname];
  const raw = typeof template === 'string' ? template : template[locale];
  const params = location.params?.[locale] ?? {};
  const filled = raw.replace(SEGMENT, (match, key: string) => params[key] ?? match);
  return filled === '/' ? `/${locale}` : `/${locale}${filled}`;
}

export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

export function localizedUrls(
  origin: string,
  location: PageLocation,
): Readonly<Record<AppLocale, string>> {
  return Object.fromEntries(
    LOCALES.map((locale) => [locale, absoluteUrl(origin, localizedPath(location, locale))]),
  ) as Record<AppLocale, string>;
}

export function alternateLanguages(
  origin: string,
  location: PageLocation,
): Readonly<Record<string, string>> {
  const urls = localizedUrls(origin, location);
  return { ...urls, 'x-default': urls[DEFAULT_LOCALE] };
}

export function entryLocation(
  pathname: AppPathname,
  param: string,
  entry: ContentEntry,
): PageLocation {
  return {
    pathname,
    params: Object.fromEntries(
      LOCALES.map((locale) => [locale, { [param]: entry.slugs[locale] }]),
    ) as Record<AppLocale, RouteParams>,
  };
}

export function staticLocation(pathname: AppPathname): PageLocation {
  return { pathname };
}
