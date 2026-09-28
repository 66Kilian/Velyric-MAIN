import { defineRouting } from 'next-intl/routing';
import { PATHNAMES } from './pathnames';

export const LOCALES = ['hu', 'de', 'en'] as const;
export type AppLocale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export const DEFAULT_LOCALE: AppLocale = 'en';

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'always',
  localeDetection: false,
  localeCookie: false,
  pathnames: PATHNAMES,
});

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function asAppLocale(value: string): AppLocale {
  return isAppLocale(value) ? value : DEFAULT_LOCALE;
}
