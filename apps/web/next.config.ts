import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const controlApiUrl = process.env['VELYRIC_CONTROL_API_URL'] ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  poweredByHeader: false,
  output: 'standalone',
  typedRoutes: false,
  images: { formats: ['image/avif', 'image/webp'] },
  redirects() {
    const solutions: Readonly<Record<string, string>> = {
      en: 'solutions',
      hu: 'megoldasok',
      de: 'loesungen',
    };
    const verticalSlugs: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      restaurant: { en: 'restaurants', hu: 'ettermek', de: 'restaurants' },
      'dental-clinic': { en: 'dental-clinics', hu: 'fogaszati-rendelo', de: 'zahnarztpraxen' },
      'auto-service': { en: 'auto-repair-shops', hu: 'autoszerviz', de: 'autowerkstatt' },
      'car-detailing': { en: 'car-detailing', hu: 'autokozmetika', de: 'fahrzeugaufbereitung' },
      salon: {
        en: 'hair-and-beauty-salons',
        hu: 'fodraszat-es-szepsegszalon',
        de: 'friseur-und-kosmetiksalons',
      },
      hotel: { en: 'hotels-and-accommodation', hu: 'szallashelyek', de: 'hotels-und-unterkuenfte' },
      'real-estate': { en: 'real-estate-agencies', hu: 'ingatlanirodak', de: 'immobilienbueros' },
      webshop: { en: 'online-stores', hu: 'webaruhazak', de: 'onlineshops' },
      'b2b-support': {
        en: 'b2b-customer-support',
        hu: 'b2b-ugyfelszolgalat',
        de: 'b2b-kundenservice',
      },
    };
    const solutionEntries = Object.entries(verticalSlugs).flatMap(([oldSlug, targets]) =>
      Object.entries(targets)
        .filter(
          ([locale, slug]) =>
            `${solutions[locale] ?? 'solutions'}/${slug}` !== `solutions/${oldSlug}`,
        )
        .map(([locale, slug]) => ({
          source: `/${locale}/solutions/${oldSlug}`,
          destination: `/${locale}/${solutions[locale] ?? 'solutions'}/${slug}`,
          permanent: true,
        })),
    );
    return Promise.resolve(solutionEntries);
  },
  rewrites() {
    return Promise.resolve({
      beforeFiles: [],
      afterFiles: [{ source: '/v1/:path*', destination: `${controlApiUrl}/v1/:path*` }],
      fallback: [],
    });
  },
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'Accept-CH', value: 'Sec-CH-Prefers-Color-Scheme' },
          { key: 'Vary', value: 'Sec-CH-Prefers-Color-Scheme' },
          { key: 'Critical-CH', value: 'Sec-CH-Prefers-Color-Scheme' },
        ],
      },
    ]);
  },
};

export default withNextIntl(nextConfig);
