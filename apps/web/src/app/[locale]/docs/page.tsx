import { BookOpen, KeyRound, ListChecks, Webhook } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MarketingHero } from '@/components/marketing/content';
import { Breadcrumbs } from '@/components/marketing/sections';
import { asAppLocale } from '@/i18n/routing';
import { pageUpdated } from '@/content/pages';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl } from '@/lib/seo/server';
import { staticLocation } from '@/lib/seo/urls';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'marketing.docsPage' });
  return pageMetadata({
    locale: asAppLocale(locale),
    location: staticLocation('/docs'),
    title: t('title'),
    description: t('body'),
  });
}

export default async function DocsPage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const appLocale = asAppLocale(locale);
  const [t, tn] = await Promise.all([
    getTranslations('marketing.docsPage'),
    getTranslations('navigation.marketing'),
  ]);
  const location = staticLocation('/docs');
  const graph = pageGraph({
    locale: appLocale,
    location,
    name: t('title'),
    description: t('body'),
    dateModified: pageUpdated('/docs'),
    breadcrumb: [
      { name: tn('home'), url: pageUrl(staticLocation('/'), appLocale) },
      { name: tn('docs'), url: pageUrl(location, appLocale) },
    ],
  });
  const sections = [
    { key: 'authentication', icon: KeyRound },
    { key: 'conventions', icon: ListChecks },
    { key: 'resources', icon: BookOpen },
    { key: 'errors', icon: Webhook },
  ] as const;
  return (
    <>
      <JsonLd data={graph} />
      <Breadcrumbs
        label={tn('home')}
        current={tn('docs')}
        items={[{ label: tn('home'), href: { pathname: '/' } }]}
      />
      <MarketingHero eyebrow={t('eyebrow')} title={t('title')} body={t('body')} />
      <section className="mx-auto grid w-full max-w-5xl gap-4 px-4 pb-16 md:grid-cols-2 md:px-8">
        {sections.map((section) => (
          <article
            key={section.key}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-6 shadow-soft"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-pink-tint text-pink-text">
              <section.icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <h2 className="text-lg font-semibold text-text">
              {t(`sections.${section.key}.title`)}
            </h2>
            <p className="text-sm text-text-muted">{t(`sections.${section.key}.body`)}</p>
            <pre className="whitespace-pre-wrap wrap-anywhere rounded-md bg-surface-muted p-3 font-mono text-xs text-text">
              {t(`sections.${section.key}.example`)}
            </pre>
          </article>
        ))}
      </section>
    </>
  );
}
