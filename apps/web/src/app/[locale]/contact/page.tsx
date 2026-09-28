import { BookOpen, Mail, ShieldCheck, Rocket } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MarketingHero } from '@/components/marketing/content';
import {
  AnswerBlock,
  Breadcrumbs,
  CardGrid,
  FaqList,
  KeyFacts,
  RelatedLinks,
  Section,
  SectionHeading,
} from '@/components/marketing/sections';
import { BottomCta } from '@/components/marketing/showcase';
import { asAppLocale, LOCALES } from '@/i18n/routing';
import { pageUpdated } from '@/content/pages';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl, seoOrigin } from '@/lib/seo/server';
import { contactPageSchema } from '@/lib/seo/structured-data';
import { staticLocation } from '@/lib/seo/urls';
import { webConfig } from '@/server/config';

const FAQ_KEYS = ['start', 'languages', 'gdpr', 'security', 'phone'] as const;
const PREPARE_KEYS = ['business', 'volume', 'languages', 'calendar', 'numbers'] as const;

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'marketingContact' });
  return pageMetadata({
    locale: asAppLocale(locale),
    location: staticLocation('/contact'),
    title: t('meta.title'),
    description: t('meta.description'),
  });
}

export default async function ContactPage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const appLocale = asAppLocale(locale);
  const [t, tn] = await Promise.all([
    getTranslations('marketingContact'),
    getTranslations('navigation.marketing'),
  ]);
  const { legalEntity } = webConfig();
  const location = staticLocation('/contact');
  const contactUrl = pageUrl(location, appLocale);
  const faq = FAQ_KEYS.map((key) => ({
    question: t(`faq.${key}.question`),
    answer: t(`faq.${key}.answer`),
  }));
  const channels = [
    {
      key: 'sales',
      icon: <Mail className="h-5 w-5" aria-hidden="true" />,
      href: `mailto:${legalEntity.salesEmail}`,
      value: legalEntity.salesEmail,
    },
    {
      key: 'privacy',
      icon: <ShieldCheck className="h-5 w-5" aria-hidden="true" />,
      href: `mailto:${legalEntity.privacyEmail}`,
      value: legalEntity.privacyEmail,
    },
    {
      key: 'security',
      icon: <BookOpen className="h-5 w-5" aria-hidden="true" />,
      href: null,
      value: null,
    },
    {
      key: 'selfServe',
      icon: <Rocket className="h-5 w-5" aria-hidden="true" />,
      href: null,
      value: null,
    },
  ] as const;
  return (
    <>
      <JsonLd
        data={pageGraph({
          locale: appLocale,
          location,
          name: t('meta.title'),
          description: t('meta.description'),
          dateModified: pageUpdated('/contact'),
          faq,
          breadcrumb: [
            { name: tn('home'), url: pageUrl(staticLocation('/'), appLocale) },
            { name: tn('contact'), url: contactUrl },
          ],
          extra: [
            contactPageSchema({
              origin: seoOrigin(),
              url: contactUrl,
              name: t('meta.title'),
              description: t('meta.description'),
              locale: appLocale,
            }),
          ],
        })}
      />
      <Breadcrumbs
        label={t('breadcrumbLabel')}
        current={tn('contact')}
        items={[{ label: tn('home'), href: { pathname: '/' } }]}
      />
      <MarketingHero eyebrow={t('eyebrow')} title={t('title')} body={t('body')} />
      <Section width="content" labelledBy="contact-answer">
        <AnswerBlock
          id="contact-answer"
          question={t('answer.question')}
          answer={t('answer.body')}
        />
      </Section>
      <Section width="wide" labelledBy="contact-channels">
        <SectionHeading
          id="contact-channels"
          title={t('channels.heading')}
          body={t('channels.body')}
        />
        <CardGrid columns={2}>
          {channels.map((channel) => (
            <div
              key={channel.key}
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-6 shadow-soft"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-pink-tint text-pink-text">
                {channel.icon}
              </span>
              <h3 className="text-lg font-semibold text-text">
                {t(`channels.${channel.key}.title`)}
              </h3>
              <p className="text-sm text-text-muted">{t(`channels.${channel.key}.body`)}</p>
              {channel.href === null ? null : (
                <a
                  href={channel.href}
                  className="text-sm font-semibold text-violet-text hover:underline"
                >
                  {channel.value}
                </a>
              )}
            </div>
          ))}
        </CardGrid>
      </Section>
      <Section width="content" labelledBy="contact-prepare">
        <SectionHeading
          id="contact-prepare"
          title={t('prepare.heading')}
          body={t('prepare.body')}
        />
        <ul className="mt-6 flex flex-col gap-2 text-[15px] text-text-muted">
          {PREPARE_KEYS.map((key) => (
            <li key={key} className="flex gap-3">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-pink" aria-hidden="true" />
              {t(`prepare.items.${key}`)}
            </li>
          ))}
        </ul>
      </Section>
      <Section width="content" labelledBy="contact-details">
        <SectionHeading
          id="contact-details"
          title={t('details.heading')}
          body={t('details.body')}
        />
        <KeyFacts
          items={[
            { term: t('details.labels.entity'), value: legalEntity.name },
            { term: t('details.labels.address'), value: legalEntity.address },
            { term: t('details.labels.registration'), value: legalEntity.registration },
            { term: t('details.labels.taxNumber'), value: legalEntity.taxNumber },
            { term: t('details.labels.sales'), value: legalEntity.salesEmail },
            { term: t('details.labels.privacy'), value: legalEntity.privacyEmail },
          ]}
        />
      </Section>
      <Section width="content" labelledBy="contact-faq">
        <FaqList items={faq} heading={t('faq.heading')} headingId="contact-faq" />
      </Section>
      <Section width="wide" labelledBy="contact-related">
        <RelatedLinks
          heading={t('related.heading')}
          headingId="contact-related"
          links={[
            {
              label: t('related.pricing.label'),
              description: t('related.pricing.description'),
              href: { pathname: '/pricing' },
            },
            {
              label: t('related.security.label'),
              description: t('related.security.description'),
              href: { pathname: '/security' },
            },
            {
              label: t('related.docs.label'),
              description: t('related.docs.description'),
              href: { pathname: '/docs' },
            },
            {
              label: t('related.product.label'),
              description: t('related.product.description'),
              href: { pathname: '/product' },
            },
          ]}
        />
      </Section>
      <BottomCta />
    </>
  );
}
