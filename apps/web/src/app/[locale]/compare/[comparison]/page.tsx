import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MarketingHero } from '@/components/marketing/content';
import {
  AnswerBlock,
  Breadcrumbs,
  ComparisonTable,
  FaqList,
  KeyFacts,
  PrimaryCta,
  Prose,
  RelatedLinks,
  SecondaryCta,
  Section,
  SectionHeading,
  StepList,
} from '@/components/marketing/sections';
import type { MarketingHref, RelatedLink } from '@/components/marketing/sections';
import { BottomCta } from '@/components/marketing/showcase';
import { COMPARISONS, entryBySlug } from '@/content/collections';
import { asAppLocale, LOCALES, type AppLocale } from '@/i18n/routing';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl } from '@/lib/seo/server';
import { entryLocation, staticLocation } from '@/lib/seo/urls';

const ROW_KEYS = [
  'availability',
  'pickup',
  'language',
  'questions',
  'booking',
  'escalation',
  'concurrency',
  'changes',
  'data',
  'cost',
] as const;

const STEP_KEYS = ['s1', 's2', 's3', 's4'] as const;

const FACT_KEYS = ['plans', 'minutes', 'concurrency', 'included'] as const;

const FAQ_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as const;

const CAPABILITY: Readonly<Record<string, MarketingHref>> = {
  'vs-call-center': { pathname: '/call-transfer' },
  'vs-ivr': { pathname: '/multilingual' },
  'vs-voicemail': { pathname: '/appointment-booking' },
};

export function generateStaticParams() {
  return LOCALES.flatMap((locale) =>
    COMPARISONS.map((entry) => ({ locale, comparison: entry.slugs[locale] })),
  );
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string; comparison: string }>;
}): Promise<Metadata> {
  const { locale, comparison } = await params;
  const appLocale = asAppLocale(locale);
  const entry = entryBySlug(COMPARISONS, appLocale, comparison);
  if (entry === undefined) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: `marketingCompare.${entry.id}` });
  return pageMetadata({
    locale: appLocale,
    location: entryLocation('/compare/[comparison]', 'comparison', entry),
    title: t('meta.title'),
    description: t('meta.description'),
  });
}

export default async function ComparisonPage({
  params,
}: {
  readonly params: Promise<{ locale: string; comparison: string }>;
}) {
  const { locale, comparison } = await params;
  const appLocale: AppLocale = asAppLocale(locale);
  const entry = entryBySlug(COMPARISONS, appLocale, comparison);
  if (entry === undefined) {
    notFound();
  }
  const capability = CAPABILITY[entry.id];
  if (capability === undefined) {
    notFound();
  }
  setRequestLocale(locale);
  const [t, tc, tn] = await Promise.all([
    getTranslations(`marketingCompare.${entry.id}`),
    getTranslations('marketingCompare'),
    getTranslations('navigation.marketing'),
  ]);
  const location = entryLocation('/compare/[comparison]', 'comparison', entry);
  const faq = FAQ_KEYS.map((key) => ({
    question: t(`faq.${key}.question`),
    answer: t(`faq.${key}.answer`),
  }));
  const rows = ROW_KEYS.map((key) => ({
    criterion: t(`table.rows.${key}.criterion`),
    values: [t(`table.rows.${key}.velyric`), t(`table.rows.${key}.other`)],
  }));
  const related: readonly RelatedLink[] = [
    ...COMPARISONS.filter((item) => item.id !== entry.id).map(
      (item): RelatedLink => ({
        label: tc(`${item.id}.card.label`),
        description: tc(`${item.id}.card.description`),
        href: {
          pathname: '/compare/[comparison]',
          params: { comparison: item.slugs[appLocale] },
        },
      }),
    ),
    {
      label: t('related.capability.label'),
      description: t('related.capability.description'),
      href: capability,
    },
    {
      label: tc('common.pricing.label'),
      description: tc('common.pricing.description'),
      href: { pathname: '/pricing' },
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
          dateModified: entry.updated,
          faq,
          breadcrumb: [
            { name: tn('home'), url: pageUrl(staticLocation('/'), appLocale) },
            { name: tn('product'), url: pageUrl(staticLocation('/product'), appLocale) },
            { name: t('breadcrumb'), url: pageUrl(location, appLocale) },
          ],
        })}
      />
      <Breadcrumbs
        label={tc('common.breadcrumbLabel')}
        current={t('breadcrumb')}
        items={[
          { label: tn('home'), href: { pathname: '/' } },
          { label: tn('product'), href: { pathname: '/product' } },
        ]}
      />
      <MarketingHero eyebrow={t('eyebrow')} title={t('title')} body={t('body')}>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <PrimaryCta href={{ pathname: '/signup' }}>{tc('common.ctaPrimary')}</PrimaryCta>
          <SecondaryCta href={{ pathname: '/pricing' }}>{tc('common.ctaSecondary')}</SecondaryCta>
        </div>
      </MarketingHero>
      <Section width="content" labelledBy="summary">
        <AnswerBlock id="summary" question={t('summary.question')} answer={t('summary.answer')} />
      </Section>
      <Section width="wide" labelledBy="comparison">
        <SectionHeading id="comparison" title={t('table.heading')} body={t('table.intro')} />
        <ComparisonTable
          caption={t('table.caption')}
          columns={[
            tc('common.criterion'),
            t('table.columns.velyric'),
            t('table.columns.other'),
          ]}
          rows={rows}
        />
      </Section>
      <Section width="content" labelledBy="caller">
        <AnswerBlock id="caller" question={t('caller.question')} answer={t('caller.answer')}>
          <Prose>
            <p>{t('caller.first')}</p>
            <p>{t('caller.second')}</p>
          </Prose>
        </AnswerBlock>
      </Section>
      <Section width="content" labelledBy="fallback">
        <AnswerBlock id="fallback" question={t('fallback.question')} answer={t('fallback.answer')}>
          <Prose>
            <p>{t('fallback.first')}</p>
            <p>{t('fallback.second')}</p>
          </Prose>
        </AnswerBlock>
      </Section>
      <Section width="content" labelledBy="setup">
        <AnswerBlock id="setup" question={t('setup.question')} answer={t('setup.answer')}>
          <StepList
            steps={STEP_KEYS.map((key) => ({
              title: t(`setup.steps.${key}.title`),
              body: t(`setup.steps.${key}.body`),
            }))}
          />
        </AnswerBlock>
      </Section>
      <Section width="content" labelledBy="reporting">
        <AnswerBlock
          id="reporting"
          question={t('reporting.question')}
          answer={t('reporting.answer')}
        >
          <Prose>
            <p>{t('reporting.first')}</p>
            <p>{t('reporting.second')}</p>
          </Prose>
        </AnswerBlock>
      </Section>
      <Section width="content" labelledBy="cost">
        <AnswerBlock id="cost" question={t('cost.question')} answer={t('cost.answer')}>
          <Prose>
            <p>{t('cost.first')}</p>
            <p>{t('cost.second')}</p>
          </Prose>
          <KeyFacts
            items={FACT_KEYS.map((key) => ({
              term: t(`cost.facts.${key}.term`),
              value: t(`cost.facts.${key}.value`),
            }))}
          />
        </AnswerBlock>
      </Section>
      <Section width="content" labelledBy="alternative">
        <AnswerBlock
          id="alternative"
          question={t('alternative.question')}
          answer={t('alternative.answer')}
        >
          <Prose>
            <p>{t('alternative.first')}</p>
            <p>{t('alternative.second')}</p>
            <p>{t('alternative.third')}</p>
          </Prose>
        </AnswerBlock>
      </Section>
      <Section width="content" labelledBy="faq">
        <FaqList items={faq} heading={tc('common.faqHeading')} headingId="faq" />
      </Section>
      <Section width="content" labelledBy="related">
        <RelatedLinks heading={tc('common.relatedHeading')} headingId="related" links={related} />
      </Section>
      <BottomCta />
    </>
  );
}
