import type { Metadata } from 'next';
import type { AppLocale } from '@/i18n/routing';
import {
  absoluteUrl,
  alternateLanguages,
  localizedPath,
  localizedUrls,
  type PageLocation,
} from './urls';

export const BRAND_NAME = 'Velyric';
export const PRODUCTION_ORIGIN = 'https://velyric.com';

export const OG_LOCALES: Readonly<Record<AppLocale, string>> = {
  hu: 'hu_HU',
  de: 'de_DE',
  en: 'en_US',
};

export interface PageSeoInput {
  readonly origin: string;
  readonly locale: AppLocale;
  readonly location: PageLocation;
  readonly title: string;
  readonly description: string;
  readonly ogType?: 'website' | 'article';
  readonly noindex?: boolean;
  readonly absoluteTitle?: boolean;
  readonly imagePath?: string;
}

export function ogImagePath(locale: AppLocale, title: string): string {
  return `/og?locale=${locale}&title=${encodeURIComponent(title.slice(0, 120))}`;
}

export function buildMetadata(input: PageSeoInput): Metadata {
  const canonical = absoluteUrl(input.origin, localizedPath(input.location, input.locale));
  const image = absoluteUrl(
    input.origin,
    input.imagePath ?? ogImagePath(input.locale, input.title),
  );
  const alternateLocales = Object.entries(localizedUrls(input.origin, input.location))
    .filter(([locale]) => locale !== input.locale)
    .map(([locale]) => OG_LOCALES[locale as AppLocale]);
  return {
    title: input.absoluteTitle === true ? { absolute: input.title } : input.title,
    description: input.description,
    alternates: input.noindex === true
      ? { canonical }
      : { canonical, languages: alternateLanguages(input.origin, input.location) },
    ...(input.noindex === true
      ? { robots: { index: false, follow: true, googleBot: { index: false, follow: true } } }
      : {}),
    openGraph: {
      type: input.ogType ?? 'website',
      url: canonical,
      siteName: BRAND_NAME,
      title: input.title,
      description: input.description,
      locale: OG_LOCALES[input.locale],
      alternateLocale: alternateLocales,
      images: [{ url: image, width: 1200, height: 630, alt: input.title }],
    },
    twitter: {
      card: 'summary_large_image',
      title: input.title,
      description: input.description,
      images: [image],
    },
  };
}
