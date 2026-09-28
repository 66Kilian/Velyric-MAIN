import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { GoogleAnalytics } from '@/components/google-analytics';
import { MarketingFooter, MarketingHeader } from '@/components/marketing/site-chrome';
import { isAppLocale, LOCALES } from '@/i18n/routing';
import { webConfig } from '@/server/config';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isAppLocale(locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'common' });
  const { legalEntity, gaMeasurementId, environment } = webConfig();
  return (
    <>
      {gaMeasurementId === null || environment !== 'production' ? null : (
        <GoogleAnalytics measurementId={gaMeasurementId} />
      )}
      <div className="vly-blush flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
        >
          {t('a11y.skipToContent')}
        </a>
        <MarketingHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <MarketingFooter
          contact={{
            address: legalEntity.address,
            salesEmail: legalEntity.salesEmail,
            registration: legalEntity.registration,
          }}
          year={new Date().getFullYear()}
        />
      </div>
    </>
  );
}
