import { describe, expect, it } from 'vitest';
import { sitePages } from '@/content/pages';
import { LOCALES, type AppLocale } from '@/i18n/routing';
import { buildMetadata, OG_LOCALES } from '@/lib/seo/metadata';
import { staticLocation } from '@/lib/seo/urls';

const ORIGIN = 'https://velyric.com';

function metadataFor(locale: AppLocale, noindex = false) {
  return buildMetadata({
    origin: ORIGIN,
    locale,
    location: staticLocation('/product'),
    title: 'AI voice agents for modern businesses',
    description:
      'Velyric answers business calls in Hungarian, German and English, books appointments and hands over to your team.',
    ...(noindex ? { noindex: true } : {}),
  });
}

describe('page metadata', () => {
  it('emits an absolute self-canonical for every locale', () => {
    for (const locale of LOCALES) {
      const metadata = metadataFor(locale);
      const canonical = metadata.alternates?.canonical;
      expect(typeof canonical).toBe('string');
      expect(typeof canonical === 'string' ? canonical : '').toContain(`${ORIGIN}/${locale}/`);
    }
  });

  it('emits a complete hreflang cluster including x-default', () => {
    const languages = metadataFor('hu').alternates?.languages ?? {};
    for (const locale of LOCALES) {
      expect(Object.keys(languages)).toContain(locale);
    }
    expect(Object.keys(languages)).toContain('x-default');
  });

  it('emits open graph and twitter cards with an image', () => {
    const metadata = metadataFor('de');
    expect(metadata.openGraph?.title).toBeTruthy();
    expect(metadata.openGraph?.description).toBeTruthy();
    expect(metadata.openGraph?.siteName).toBe('Velyric');
    expect(metadata.openGraph?.locale).toBe(OG_LOCALES.de);
    expect(JSON.stringify(metadata.twitter)).toContain('summary_large_image');
    const images = metadata.openGraph?.images;
    expect(Array.isArray(images)).toBe(true);
    const first = Array.isArray(images) ? images[0] : undefined;
    expect(JSON.stringify(first)).toContain(`${ORIGIN}/og`);
  });

  it('lists the other locales as alternate open graph locales', () => {
    const alternates = metadataFor('en').openGraph?.alternateLocale ?? [];
    expect(alternates).toContain(OG_LOCALES.hu);
    expect(alternates).toContain(OG_LOCALES.de);
    expect(alternates).not.toContain(OG_LOCALES.en);
  });

  it('drops hreflang and sets robots noindex when a page is excluded from search', () => {
    const metadata = metadataFor('en', true);
    expect(metadata.alternates?.languages).toBeUndefined();
    expect(metadata.robots).toMatchObject({ index: false, follow: true });
  });

  it('never leaks a development origin', () => {
    const serialized = JSON.stringify(metadataFor('hu'));
    expect(serialized).not.toContain('localhost');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('vercel.app');
  });

  it('keeps titles and descriptions inside search result budgets', () => {
    const title = 'AI voice agents for modern businesses';
    const description =
      'Velyric answers business calls in Hungarian, German and English, books appointments and hands over to your team.';
    expect(title.length).toBeLessThanOrEqual(70);
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(175);
  });

  it('builds metadata for every registered page without throwing', () => {
    for (const page of sitePages()) {
      for (const locale of LOCALES) {
        const metadata = buildMetadata({
          origin: ORIGIN,
          locale,
          location: page.location,
          title: page.id,
          description: page.id,
        });
        expect(metadata.alternates?.canonical).toBeTruthy();
      }
    }
  });
});
