import { CalendarCheck, MessageSquareText, PhoneForwarded } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { FeatureBlocks, MarketingHero } from '@/components/marketing/content';
import { Breadcrumbs } from '@/components/marketing/sections';
import { BottomCta } from '@/components/marketing/showcase';
import { entryBySlug, VERTICALS } from '@/content/collections';
import { Link } from '@/i18n/navigation';
import { asAppLocale, LOCALES, type AppLocale } from '@/i18n/routing';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl } from '@/lib/seo/server';
import { entryLocation, staticLocation } from '@/lib/seo/urls';

export function generateStaticParams() {
  return LOCALES.flatMap((locale) =>
    VERTICALS.map((entry) => ({ locale, vertical: entry.slugs[locale] })),
  );
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string; vertical: string }>;
}): Promise<Metadata> {
  const { locale, vertical } = await params;
  const appLocale = asAppLocale(locale);
  const entry = entryBySlug(VERTICALS, appLocale, vertical);
  if (entry === undefined) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: `marketing.solutions.${entry.id}` });
  return pageMetadata({
    locale: appLocale,
    location: entryLocation('/solutions/[vertical]', 'vertical', entry),
    title: t('title'),
    description: t('body'),
  });
}

export default async function SolutionPage({
  params,
}: {
  readonly params: Promise<{ locale: string; vertical: string }>;
}) {
  const { locale, vertical } = await params;
  const appLocale: AppLocale = asAppLocale(locale);
  const entry = entryBySlug(VERTICALS, appLocale, vertical);
  if (entry === undefined) {
    notFound();
  }
  setRequestLocale(locale);
  const [t, tv, tc, tn] = await Promise.all([
    getTranslations(`marketing.solutions.${entry.id}`),
    getTranslations('enums.vertical'),
    getTranslations('marketing.solutions.common'),
    getTranslations('navigation.marketing'),
  ]);
  const location = entryLocation('/solutions/[vertical]', 'vertical', entry);
  const graph = pageGraph({
    locale: appLocale,
    location,
    name: t('title'),
    description: t('body'),
    dateModified: entry.updated,
    breadcrumb: [
      { name: tn('home'), url: pageUrl(staticLocation('/'), appLocale) },
      { name: tn('product'), url: pageUrl(staticLocation('/product'), appLocale) },
      { name: tv(entry.id), url: pageUrl(location, appLocale) },
    ],
  });
  return (
    <>
      <JsonLd data={graph} />
      <Breadcrumbs
        label={tc('breadcrumb')}
        current={tv(entry.id)}
        items={[
          { label: tn('home'), href: { pathname: '/' } },
          { label: tn('product'), href: { pathname: '/product' } },
        ]}
      />
      <MarketingHero eyebrow={tv(entry.id)} title={t('title')} body={t('body')}>
        <Link
          href={{ pathname: '/signup' }}
          className="vly-gradient-cta inline-flex h-12 items-center rounded-full px-6 text-[15px] font-semibold shadow-cta"
        >
          {tc('cta')}
        </Link>
      </MarketingHero>
      <FeatureBlocks
        items={[
          {
            title: t('points.first.title'),
            body: t('points.first.body'),
            icon: <CalendarCheck className="h-5 w-5" aria-hidden="true" />,
          },
          {
            title: t('points.second.title'),
            body: t('points.second.body'),
            icon: <MessageSquareText className="h-5 w-5" aria-hidden="true" />,
          },
          {
            title: t('points.third.title'),
            body: t('points.third.body'),
            icon: <PhoneForwarded className="h-5 w-5" aria-hidden="true" />,
          },
        ]}
      />
      <nav
        aria-label={tc('other')}
        className="mx-auto flex w-full max-w-5xl flex-wrap justify-center gap-2 px-4 py-6"
      >
        {VERTICALS.filter((item) => item.id !== entry.id).map((item) => (
          <Link
            key={item.id}
            href={{ pathname: '/solutions/[vertical]', params: { vertical: item.slugs[appLocale] } }}
            className="rounded-full border border-border bg-surface px-4 py-2 text-sm text-text hover:border-pink/40"
          >
            {tv(item.id)}
          </Link>
        ))}
      </nav>
      <BottomCta />
    </>
  );
}
