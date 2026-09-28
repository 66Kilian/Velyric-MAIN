import { Badge } from '@velyric/ui';
import { CalendarDays, Code2, CreditCard, Mail, Phone, Webhook } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MarketingHero } from '@/components/marketing/content';
import { Breadcrumbs, Section, SectionHeading } from '@/components/marketing/sections';
import { BottomCta } from '@/components/marketing/showcase';
import { INTEGRATIONS } from '@/content/collections';
import { Link } from '@/i18n/navigation';
import { asAppLocale, LOCALES, type AppLocale } from '@/i18n/routing';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl } from '@/lib/seo/server';
import { staticLocation } from '@/lib/seo/urls';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'marketing.integrationsPage' });
  return pageMetadata({
    locale: asAppLocale(locale),
    location: staticLocation('/integrations'),
    title: t('title'),
    description: t('body'),
  });
}

const CATALOG = [
  { key: 'google', icon: CalendarDays, entry: 'google-calendar' },
  { key: 'microsoft', icon: CalendarDays, entry: 'microsoft-365' },
  { key: 'customApi', icon: Code2, entry: 'custom-api-tools' },
  { key: 'webhooks', icon: Webhook, entry: 'webhooks' },
  { key: 'telephony', icon: Phone, entry: 'phone-numbers' },
  { key: 'email', icon: Mail, entry: 'email-notifications' },
  { key: 'payments', icon: CreditCard, entry: null },
] as const;

function slugFor(entryId: string, locale: AppLocale): string | null {
  return INTEGRATIONS.find((item) => item.id === entryId)?.slugs[locale] ?? null;
}

export default async function IntegrationsPage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const appLocale = asAppLocale(locale);
  const [t, ti, tn] = await Promise.all([
    getTranslations('marketing.integrationsPage'),
    getTranslations('marketingIntegrations'),
    getTranslations('navigation.marketing'),
  ]);
  const location = staticLocation('/integrations');
  return (
    <>
      <JsonLd
        data={pageGraph({
          locale: appLocale,
          location,
          name: t('title'),
          description: t('body'),
          dateModified: '2026-09-16',
          breadcrumb: [
            { name: tn('home'), url: pageUrl(staticLocation('/'), appLocale) },
            { name: tn('integrations'), url: pageUrl(location, appLocale) },
          ],
        })}
      />
      <Breadcrumbs
        label={ti('common.breadcrumbLabel')}
        current={tn('integrations')}
        items={[{ label: tn('home'), href: { pathname: '/' } }]}
      />
      <MarketingHero eyebrow={t('eyebrow')} title={t('title')} body={t('body')} />
      <Section width="wide" labelledBy="catalog-heading">
        <SectionHeading id="catalog-heading" title={ti('hub.heading')} body={ti('hub.body')} />
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CATALOG.map((item) => {
            const slug = item.entry === null ? null : slugFor(item.entry, appLocale);
            const card = (
              <>
                <div className="flex items-center justify-between">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-pink-tint text-pink-text">
                    <item.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <Badge tone="success">{t('available')}</Badge>
                </div>
                <h3 className="text-lg font-semibold text-text">{t(`items.${item.key}.name`)}</h3>
                <p className="text-sm text-text-muted">{t(`items.${item.key}.body`)}</p>
              </>
            );
            return (
              <li key={item.key}>
                {slug === null ? (
                  <div className="flex h-full flex-col gap-3 rounded-xl border border-border bg-surface p-6 shadow-soft">
                    {card}
                  </div>
                ) : (
                  <Link
                    href={{ pathname: '/integrations/[integration]', params: { integration: slug } }}
                    className="flex h-full flex-col gap-3 rounded-xl border border-border bg-surface p-6 shadow-soft transition-colors hover:border-pink/40"
                  >
                    {card}
                    <span className="text-sm font-semibold text-violet-text">
                      {ti('hub.readMore')}
                    </span>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </Section>
      <Section width="content" labelledBy="scope-heading">
        <SectionHeading
          id="scope-heading"
          title={ti('hub.scope.heading')}
          body={ti('hub.scope.body')}
        />
        <p className="mt-4 max-w-3xl text-[15px] leading-relaxed text-text-muted">
          {ti('hub.scope.detail')}
        </p>
      </Section>
      <BottomCta />
    </>
  );
}
