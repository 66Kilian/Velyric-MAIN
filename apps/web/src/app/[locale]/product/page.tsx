import { Brain, CalendarCheck, FlaskConical, Headphones, Languages, Shield } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { FeatureBlocks, MarketingHero } from '@/components/marketing/content';
import { Breadcrumbs } from '@/components/marketing/sections';
import { BottomCta, DashboardShowcase } from '@/components/marketing/showcase';
import { Link } from '@/i18n/navigation';
import { asAppLocale } from '@/i18n/routing';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl } from '@/lib/seo/server';
import { staticLocation } from '@/lib/seo/urls';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'marketing.productPage' });
  return pageMetadata({
    locale: asAppLocale(locale),
    location: staticLocation('/product'),
    title: t('title'),
    description: t('body'),
  });
}

export default async function ProductPage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const appLocale = asAppLocale(locale);
  const [t, tn] = await Promise.all([
    getTranslations('marketing.productPage'),
    getTranslations('navigation.marketing'),
  ]);
  const location = staticLocation('/product');
  const graph = pageGraph({
    locale: appLocale,
    location,
    name: t('title'),
    description: t('body'),
    dateModified: '2026-09-16',
    breadcrumb: [
      { name: tn('home'), url: pageUrl(staticLocation('/'), appLocale) },
      { name: tn('product'), url: pageUrl(location, appLocale) },
    ],
  });
  const icon = 'h-5 w-5';
  return (
    <>
      <JsonLd data={graph} />
      <Breadcrumbs
        label={tn('home')}
        current={tn('product')}
        items={[{ label: tn('home'), href: { pathname: '/' } }]}
      />
      <MarketingHero eyebrow={t('eyebrow')} title={t('title')} body={t('body')}>
        <Link
          href="/signup"
          className="vly-gradient-cta inline-flex h-12 items-center rounded-full px-6 text-[15px] font-semibold shadow-cta"
        >
          {t('cta')}
        </Link>
      </MarketingHero>
      <FeatureBlocks
        items={[
          {
            title: t('blocks.orchestration.title'),
            body: t('blocks.orchestration.body'),
            icon: <Brain className={icon} aria-hidden="true" />,
          },
          {
            title: t('blocks.languages.title'),
            body: t('blocks.languages.body'),
            icon: <Languages className={icon} aria-hidden="true" />,
          },
          {
            title: t('blocks.booking.title'),
            body: t('blocks.booking.body'),
            icon: <CalendarCheck className={icon} aria-hidden="true" />,
          },
          {
            title: t('blocks.handoff.title'),
            body: t('blocks.handoff.body'),
            icon: <Headphones className={icon} aria-hidden="true" />,
          },
          {
            title: t('blocks.simulation.title'),
            body: t('blocks.simulation.body'),
            icon: <FlaskConical className={icon} aria-hidden="true" />,
          },
          {
            title: t('blocks.safety.title'),
            body: t('blocks.safety.body'),
            icon: <Shield className={icon} aria-hidden="true" />,
          },
        ]}
      />
      <section className="mx-auto w-full max-w-6xl px-4 py-12 md:px-8">
        <DashboardShowcase />
      </section>
      <BottomCta />
    </>
  );
}
