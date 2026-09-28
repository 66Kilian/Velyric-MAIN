import {
  CalendarDays,
  Check,
  Code2,
  FileLock2,
  Globe2,
  Phone,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import {
  BottomCta,
  DashboardShowcase,
  FeatureGrid,
  HeroVisual,
  PricingCards,
} from '@/components/marketing/showcase';
import { Link } from '@/i18n/navigation';
import { asAppLocale } from '@/i18n/routing';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, seoOrigin } from '@/lib/seo/server';
import { staticLocation } from '@/lib/seo/urls';
import {
  organizationSchema,
  softwareApplicationSchema,
  websiteSchema,
} from '@/lib/seo/structured-data';
import { webConfig } from '@/server/config';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'marketing.meta' });
  return pageMetadata({
    locale: asAppLocale(locale),
    location: staticLocation('/'),
    title: t('homeTitle'),
    description: t('homeDescription'),
    absoluteTitle: true,
  });
}

export default async function HomePage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('marketing');
  const tm = await getTranslations('marketing.meta');
  const origin = seoOrigin();
  const { legalEntity } = webConfig();
  const appLocale = asAppLocale(locale);
  const graph = pageGraph({
    locale: appLocale,
    location: staticLocation('/'),
    name: tm('homeTitle'),
    description: tm('homeDescription'),
    extra: [
      organizationSchema({
        origin,
        brandName: 'Velyric',
        description: tm('homeDescription'),
        legalEntity,
      }),
      websiteSchema({ origin, brandName: 'Velyric', locale: appLocale }),
      softwareApplicationSchema({
        origin,
        brandName: 'Velyric',
        description: tm('homeDescription'),
        locale: appLocale,
        featureList: [
          t('features.multilingual.title'),
          t('features.conversation.title'),
          t('features.booking.title'),
          t('features.integrations.title'),
          t('features.handoff.title'),
          t('features.analytics.title'),
        ],
      }),
    ],
  });
  const proof = ['languages', 'always', 'handoff', 'calendars'] as const;
  const integrations = [
    { key: 'google', icon: CalendarDays },
    { key: 'microsoft', icon: CalendarDays },
    { key: 'phone', icon: Phone },
    { key: 'api', icon: Code2 },
  ] as const;
  return (
    <>
      <JsonLd data={graph} />
      <section className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 pb-10 pt-10 md:px-8 lg:grid-cols-[1.05fr_1fr] lg:pt-16">
        <div className="flex flex-col gap-6">
          <span className="vly-eyebrow">{t('hero.eyebrow')}</span>
          <h1 className="text-[40px] font-bold leading-[1.05] tracking-[-0.03em] text-text md:text-[56px]">
            {t('hero.titleStart')}{' '}
            <span className="vly-gradient-text">{t('hero.titleHighlight')}</span>
          </h1>
          <p className="max-w-xl text-lg text-text-muted">{t('hero.body')}</p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="vly-gradient-cta inline-flex h-12 items-center rounded-full px-6 text-[15px] font-semibold shadow-cta"
            >
              {t('hero.primary')}
            </Link>
            <Link
              href="/product"
              className="inline-flex h-12 items-center rounded-full border border-border bg-surface px-6 text-[15px] font-semibold text-text shadow-soft hover:border-pink/40"
            >
              {t('hero.secondary')}
            </Link>
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-text-muted">
            {proof.map((key) => (
              <li key={key} className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-pink-tint text-pink-text">
                  <Check className="h-3 w-3" aria-hidden="true" />
                </span>
                {t(`proof.${key}`)}
              </li>
            ))}
          </ul>
        </div>
        <HeroVisual />
      </section>

      <section
        aria-labelledby="features-heading"
        className="mx-auto w-full max-w-7xl px-4 py-10 md:px-8"
      >
        <h2 id="features-heading" className="sr-only">
          {t('features.heading')}
        </h2>
        <FeatureGrid />
      </section>

      <section
        aria-labelledby="showcase-heading"
        className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-16 md:px-8 lg:grid-cols-[0.8fr_1.4fr]"
      >
        <div className="flex flex-col gap-5">
          <span className="vly-eyebrow">{t('command.eyebrow')}</span>
          <h2
            id="showcase-heading"
            className="text-[34px] font-bold leading-tight tracking-[-0.02em] text-text"
          >
            {t('command.titleStart')}{' '}
            <span className="vly-gradient-text">{t('command.titleHighlight')}</span>
          </h2>
          <p className="text-text-muted">{t('command.body')}</p>
          <ul className="flex flex-col gap-3">
            {(['live', 'summaries', 'languages', 'integrations', 'analytics'] as const).map(
              (key) => (
                <li key={key} className="flex items-center gap-3 text-text">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-pink-tint text-pink-text">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  {t(`command.items.${key}`)}
                </li>
              ),
            )}
          </ul>
        </div>
        <DashboardShowcase />
      </section>

      <section
        aria-labelledby="integrations-heading"
        className="mx-auto w-full max-w-7xl px-4 py-12 md:px-8"
      >
        <span className="vly-eyebrow">{t('integrations.eyebrow')}</span>
        <h2
          id="integrations-heading"
          className="mt-2 text-[34px] font-bold tracking-[-0.02em] text-text"
        >
          {t('integrations.title')}
        </h2>
        <p className="mt-1 text-text-muted">{t('integrations.body')}</p>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {integrations.map((item) => (
            <li
              key={item.key}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-4 shadow-soft"
            >
              <item.icon className="h-6 w-6 text-pink-text" aria-hidden="true" />
              <span className="flex flex-col">
                <span className="font-semibold text-text">
                  {t(`integrations.items.${item.key}.name`)}
                </span>
                <span className="text-xs text-text-muted">
                  {t(`integrations.items.${item.key}.detail`)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="pricing-heading"
        className="mx-auto w-full max-w-7xl px-4 py-12 md:px-8"
      >
        <span className="vly-eyebrow">{t('pricing.eyebrow')}</span>
        <h2
          id="pricing-heading"
          className="mb-6 mt-2 text-[34px] font-bold tracking-[-0.02em] text-text"
        >
          {t('pricing.title')}
        </h2>
        <PricingCards compact />
      </section>

      <section
        aria-labelledby="trust-heading"
        className="mx-auto w-full max-w-7xl px-4 py-12 md:px-8"
      >
        <div className="grid gap-6 rounded-2xl border border-border bg-surface p-8 shadow-soft md:grid-cols-[1fr_2fr]">
          <div>
            <span className="vly-eyebrow">{t('trust.eyebrow')}</span>
            <h2 id="trust-heading" className="mt-2 text-2xl font-bold text-text">
              {t('trust.title')}
            </h2>
            <Link
              href="/security"
              className="mt-3 inline-block text-sm font-semibold text-violet-text hover:underline"
            >
              {t('trust.link')}
            </Link>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2">
            {[
              { key: 'disclosure', icon: Users },
              { key: 'gdpr', icon: FileLock2 },
              { key: 'audit', icon: ShieldCheck },
              { key: 'eu', icon: Globe2 },
            ].map((item) => (
              <li key={item.key} className="flex gap-3">
                <item.icon className="mt-0.5 h-5 w-5 shrink-0 text-pink-text" aria-hidden="true" />
                <span>
                  <span className="block font-semibold text-text">
                    {t(`trust.items.${item.key}.title`)}
                  </span>
                  <span className="text-sm text-text-muted">
                    {t(`trust.items.${item.key}.body`)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <BottomCta />
    </>
  );
}
