import { Eye, FileLock2, KeyRound, ScrollText, ShieldCheck, Siren } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { FeatureBlocks, MarketingHero } from '@/components/marketing/content';
import { Breadcrumbs } from '@/components/marketing/sections';
import { BottomCta } from '@/components/marketing/showcase';
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
  const t = await getTranslations({ locale, namespace: 'marketing.securityPage' });
  return pageMetadata({
    locale: asAppLocale(locale),
    location: staticLocation('/security'),
    title: t('title'),
    description: t('body'),
  });
}

export default async function SecurityPage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const appLocale = asAppLocale(locale);
  const [t, tn] = await Promise.all([
    getTranslations('marketing.securityPage'),
    getTranslations('navigation.marketing'),
  ]);
  const location = staticLocation('/security');
  const graph = pageGraph({
    locale: appLocale,
    location,
    name: t('title'),
    description: t('body'),
    dateModified: '2026-09-16',
    breadcrumb: [
      { name: tn('home'), url: pageUrl(staticLocation('/'), appLocale) },
      { name: tn('security'), url: pageUrl(location, appLocale) },
    ],
  });
  const icon = 'h-5 w-5';
  return (
    <>
      <JsonLd data={graph} />
      <Breadcrumbs
        label={tn('home')}
        current={tn('security')}
        items={[{ label: tn('home'), href: { pathname: '/' } }]}
      />
      <MarketingHero eyebrow={t('eyebrow')} title={t('title')} body={t('body')} />
      <FeatureBlocks
        items={[
          {
            title: t('blocks.isolation.title'),
            body: t('blocks.isolation.body'),
            icon: <ShieldCheck className={icon} aria-hidden="true" />,
          },
          {
            title: t('blocks.secrets.title'),
            body: t('blocks.secrets.body'),
            icon: <KeyRound className={icon} aria-hidden="true" />,
          },
          {
            title: t('blocks.disclosure.title'),
            body: t('blocks.disclosure.body'),
            icon: <Eye className={icon} aria-hidden="true" />,
          },
          {
            title: t('blocks.privacy.title'),
            body: t('blocks.privacy.body'),
            icon: <FileLock2 className={icon} aria-hidden="true" />,
          },
          {
            title: t('blocks.audit.title'),
            body: t('blocks.audit.body'),
            icon: <ScrollText className={icon} aria-hidden="true" />,
          },
          {
            title: t('blocks.killSwitches.title'),
            body: t('blocks.killSwitches.body'),
            icon: <Siren className={icon} aria-hidden="true" />,
          },
        ]}
      />
      <BottomCta />
    </>
  );
}
