import { PLAN_CATALOG } from '@velyric/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MarketingHero } from '@/components/marketing/content';
import { Breadcrumbs, FaqList, Section } from '@/components/marketing/sections';
import { BottomCta, PricingCards } from '@/components/marketing/showcase';
import { asAppLocale } from '@/i18n/routing';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl, seoOrigin } from '@/lib/seo/server';
import { softwareApplicationSchema, type SoftwareOffer } from '@/lib/seo/structured-data';
import { staticLocation } from '@/lib/seo/urls';

const PLAN_CODES = ['START', 'BUSINESS', 'PRO'] as const;

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'marketing.pricingPage' });
  return pageMetadata({
    locale: asAppLocale(locale),
    location: staticLocation('/pricing'),
    title: t('title'),
    description: t('body'),
  });
}

export default async function PricingPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, search] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  const appLocale = asAppLocale(locale);
  const [t, tp, tn] = await Promise.all([
    getTranslations('marketing.pricingPage'),
    getTranslations('marketing.pricing'),
    getTranslations('navigation.marketing'),
  ]);
  const location = staticLocation('/pricing');
  const pricingUrl = pageUrl(location, appLocale);
  const faq = (['vat', 'overage', 'change', 'numbers'] as const).map((key) => ({
    question: t(`faq.${key}.question`),
    answer: t(`faq.${key}.answer`),
  }));
  const offers: SoftwareOffer[] = PLAN_CODES.flatMap((code) => {
    const price = PLAN_CATALOG[code].prices.find((entry) => entry.market === 'HU');
    return price === undefined
      ? []
      : [
          {
            name: tp(`plans.${code}.name`),
            price: price.monthlyNetMinor / 100,
            currency: price.currency,
            unit: 'MONTH' as const,
            url: pricingUrl,
          },
        ];
  });
  return (
    <>
      <JsonLd
        data={pageGraph({
          locale: appLocale,
          location,
          name: t('title'),
          description: t('body'),
          dateModified: '2026-09-16',
          faq,
          breadcrumb: [
            { name: tn('home'), url: pageUrl(staticLocation('/'), appLocale) },
            { name: tn('pricing'), url: pricingUrl },
          ],
          extra: [
            softwareApplicationSchema({
              origin: seoOrigin(),
              brandName: 'Velyric',
              description: t('body'),
              locale: appLocale,
              featureList: PLAN_CODES.map((code) => tp(`plans.${code}.name`)),
              offers,
            }),
          ],
        })}
      />
      <Breadcrumbs
        label={tn('home')}
        current={tn('pricing')}
        items={[{ label: tn('home'), href: { pathname: '/' } }]}
      />
      <MarketingHero eyebrow={t('eyebrow')} title={t('title')} body={t('body')} />
      {search['checkout'] === 'canceled' ? (
        <p className="mx-auto mb-4 max-w-xl rounded-md border border-warning/50 bg-surface px-4 py-2 text-center text-sm text-warning-text">
          {t('canceled')}
        </p>
      ) : null}
      <section aria-labelledby="pricing-plans" className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8">
        <h2 id="pricing-plans" className="sr-only">
          {tp('title')}
        </h2>
        <PricingCards />
        <p className="mt-4 text-center text-xs text-text-muted">{t('footnote')}</p>
      </section>
      <Section width="narrow" labelledBy="pricing-faq">
        <FaqList items={faq} heading={t('faqTitle')} headingId="pricing-faq" />
      </Section>
      <BottomCta />
    </>
  );
}
