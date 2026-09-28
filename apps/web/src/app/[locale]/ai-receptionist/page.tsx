import { BookOpenText, Hash, MoonStar, PhoneCall, ShieldCheck, Wrench } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MarketingHero } from '@/components/marketing/content';
import {
  AnswerBlock,
  Breadcrumbs,
  CardGrid,
  FaqList,
  FeatureCard,
  KeyFacts,
  PrimaryCta,
  Prose,
  RelatedLinks,
  Section,
  SectionHeading,
  SecondaryCta,
  StepList,
} from '@/components/marketing/sections';
import type { RelatedLink } from '@/components/marketing/sections';
import { BottomCta } from '@/components/marketing/showcase';
import { VERTICALS } from '@/content/collections';
import { asAppLocale, LOCALES } from '@/i18n/routing';
import { pageUpdated } from '@/content/pages';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl } from '@/lib/seo/server';
import { staticLocation } from '@/lib/seo/urls';

const ICON = 'h-5 w-5';
const PATH = '/ai-receptionist';
const UPDATED = pageUpdated('/ai-receptionist');
const STEPS = [1, 2, 3, 4, 5, 6];
const FACTS = [1, 2, 3, 4, 5, 6, 7, 8];
const QUESTIONS = [1, 2, 3, 4, 5, 6, 7];
const LIMITS = [1, 2, 3, 4, 5, 6];

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'marketingCapabilities.receptionist' });
  return pageMetadata({
    locale: asAppLocale(locale),
    location: staticLocation(PATH),
    title: t('meta.title'),
    description: t('meta.description'),
  });
}

export default async function AiReceptionistPage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const appLocale = asAppLocale(locale);
  const [t, tc, tn] = await Promise.all([
    getTranslations('marketingCapabilities.receptionist'),
    getTranslations('marketingCapabilities.common'),
    getTranslations('navigation.marketing'),
  ]);
  const location = staticLocation(PATH);
  const faq = QUESTIONS.map((index) => ({
    question: t(`faq.q${String(index)}.question`),
    answer: t(`faq.q${String(index)}.answer`),
  }));
  const steps = STEPS.map((index) => ({
    title: t(`how.s${String(index)}.title`),
    body: t(`how.s${String(index)}.body`),
  }));
  const facts = FACTS.map((index) => ({
    term: t(`facts.f${String(index)}.term`),
    value: t(`facts.f${String(index)}.value`),
  }));
  const capabilities = [
    { key: 'c1', icon: <PhoneCall className={ICON} aria-hidden="true" /> },
    { key: 'c2', icon: <ShieldCheck className={ICON} aria-hidden="true" /> },
    { key: 'c3', icon: <Hash className={ICON} aria-hidden="true" /> },
    { key: 'c4', icon: <BookOpenText className={ICON} aria-hidden="true" /> },
    { key: 'c5', icon: <Wrench className={ICON} aria-hidden="true" /> },
    { key: 'c6', icon: <MoonStar className={ICON} aria-hidden="true" /> },
  ];
  const verticalLinks: readonly RelatedLink[] = VERTICALS.filter(
    (entry) => entry.id === 'dental-clinic',
  ).map((entry) => ({
    label: t('related.r5.label'),
    description: t('related.r5.description'),
    href: { pathname: '/solutions/[vertical]', params: { vertical: entry.slugs[appLocale] } },
  }));
  const related: readonly RelatedLink[] = [
    {
      label: t('related.r1.label'),
      description: t('related.r1.description'),
      href: { pathname: '/appointment-booking' },
    },
    {
      label: t('related.r2.label'),
      description: t('related.r2.description'),
      href: { pathname: '/multilingual' },
    },
    {
      label: t('related.r3.label'),
      description: t('related.r3.description'),
      href: { pathname: '/call-transfer' },
    },
    {
      label: t('related.r4.label'),
      description: t('related.r4.description'),
      href: { pathname: '/pricing' },
    },
    ...verticalLinks,
    {
      label: t('related.r6.label'),
      description: t('related.r6.description'),
      href: { pathname: '/product' },
    },
  ];
  return (
    <>
      <JsonLd
        data={pageGraph({
          locale: appLocale,
          location,
          name: t('meta.title'),
          description: t('meta.description'),
          dateModified: UPDATED,
          faq,
          breadcrumb: [
            { name: tn('home'), url: pageUrl(staticLocation('/'), appLocale) },
            { name: tn('product'), url: pageUrl(staticLocation('/product'), appLocale) },
            { name: t('breadcrumb'), url: pageUrl(location, appLocale) },
          ],
        })}
      />
      <Breadcrumbs
        label={tc('breadcrumbLabel')}
        current={t('breadcrumb')}
        items={[
          { label: tn('home'), href: { pathname: '/' } },
          { label: tn('product'), href: { pathname: '/product' } },
        ]}
      />
      <MarketingHero eyebrow={t('eyebrow')} title={t('title')} body={t('body')}>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <PrimaryCta href={{ pathname: '/signup' }}>{tc('ctaPrimary')}</PrimaryCta>
          <SecondaryCta href={{ pathname: '/pricing' }}>{tc('ctaSecondary')}</SecondaryCta>
        </div>
      </MarketingHero>
      <Section width="content" labelledBy="answer-heading">
        <AnswerBlock
          id="answer-heading"
          question={t('answer.question')}
          answer={t('answer.body')}
        />
      </Section>
      <Section width="content" labelledBy="context-heading">
        <SectionHeading
          id="context-heading"
          title={t('context.heading')}
          body={t('context.body')}
        />
        <div className="mt-6">
          <Prose>
            <p>{t('context.p1')}</p>
            <p>{t('context.p2')}</p>
          </Prose>
        </div>
      </Section>
      <Section width="content" labelledBy="how-heading">
        <SectionHeading id="how-heading" title={t('how.heading')} body={t('how.body')} />
        <StepList steps={steps} />
      </Section>
      <Section width="wide" labelledBy="capabilities-heading">
        <SectionHeading
          id="capabilities-heading"
          title={t('capabilities.heading')}
          body={t('capabilities.body')}
        />
        <CardGrid>
          {capabilities.map((item) => (
            <FeatureCard
              key={item.key}
              title={t(`capabilities.${item.key}.title`)}
              body={t(`capabilities.${item.key}.body`)}
              icon={item.icon}
            />
          ))}
        </CardGrid>
      </Section>
      <Section width="content" labelledBy="facts-heading">
        <SectionHeading id="facts-heading" title={t('facts.heading')} body={t('facts.body')} />
        <KeyFacts items={facts} />
      </Section>
      <Section width="content" labelledBy="limits-heading">
        <SectionHeading id="limits-heading" title={t('limits.heading')} body={t('limits.body')} />
        <CardGrid columns={2}>
          {LIMITS.map((index) => (
            <FeatureCard
              key={`limit-${String(index)}`}
              title={t(`limits.l${String(index)}.title`)}
              body={t(`limits.l${String(index)}.body`)}
            />
          ))}
        </CardGrid>
      </Section>
      <Section width="content" labelledBy="faq-heading">
        <FaqList items={faq} heading={t('faq.heading')} headingId="faq-heading" />
      </Section>
      <Section width="content" labelledBy="related-heading">
        <RelatedLinks heading={t('related.heading')} headingId="related-heading" links={related} />
      </Section>
      <BottomCta />
    </>
  );
}
