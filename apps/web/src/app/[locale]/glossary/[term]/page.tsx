import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MarketingHero } from '@/components/marketing/content';
import {
  AnswerBlock,
  Breadcrumbs,
  FaqList,
  KeyFacts,
  Prose,
  RelatedLinks,
  Section,
  SectionHeading,
} from '@/components/marketing/sections';
import type { MarketingHref, RelatedLink } from '@/components/marketing/sections';
import { BottomCta } from '@/components/marketing/showcase';
import { entryBySlug, GLOSSARY_TERMS, type ContentEntry } from '@/content/collections';
import { asAppLocale, LOCALES, type AppLocale } from '@/i18n/routing';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl, seoOrigin } from '@/lib/seo/server';
import { definedTermSchema } from '@/lib/seo/structured-data';
import { entryLocation, staticLocation } from '@/lib/seo/urls';

interface TermLayout {
  readonly related: readonly string[];
  readonly capability: MarketingHref;
}

const LAYOUT: Readonly<Record<string, TermLayout>> = {
  'ai-voice-agent': {
    related: ['ai-receptionist', 'ivr', 'rag'],
    capability: { pathname: '/product' },
  },
  'ai-receptionist': {
    related: ['ai-voice-agent', 'warm-transfer', 'concurrent-calls'],
    capability: { pathname: '/ai-receptionist' },
  },
  ivr: {
    related: ['dtmf', 'ai-voice-agent', 'warm-transfer'],
    capability: { pathname: '/ai-receptionist' },
  },
  sip: {
    related: ['pstn', 'did', 'warm-transfer'],
    capability: { pathname: '/integrations' },
  },
  pstn: {
    related: ['sip', 'did', 'e164'],
    capability: { pathname: '/integrations' },
  },
  did: {
    related: ['pstn', 'e164', 'concurrent-calls'],
    capability: { pathname: '/integrations' },
  },
  dtmf: {
    related: ['ivr', 'barge-in', 'warm-transfer'],
    capability: { pathname: '/call-transfer' },
  },
  'barge-in': {
    related: ['dtmf', 'ai-voice-agent', 'ivr'],
    capability: { pathname: '/product' },
  },
  'warm-transfer': {
    related: ['sip', 'dtmf', 'ai-receptionist'],
    capability: { pathname: '/call-transfer' },
  },
  e164: {
    related: ['pstn', 'did', 'sip'],
    capability: { pathname: '/multilingual' },
  },
  'concurrent-calls': {
    related: ['did', 'ai-receptionist', 'pstn'],
    capability: { pathname: '/pricing' },
  },
  rag: {
    related: ['ai-voice-agent', 'ai-receptionist', 'ivr'],
    capability: { pathname: '/product' },
  },
};

const FACT_KEYS = ['f1', 'f2', 'f3'] as const;
const FAQ_KEYS = ['q1', 'q2', 'q3'] as const;

function termsByIds(ids: readonly string[]): readonly ContentEntry[] {
  return ids
    .map((id) => GLOSSARY_TERMS.find((entry) => entry.id === id))
    .filter((entry): entry is ContentEntry => entry !== undefined);
}

export function generateStaticParams() {
  return LOCALES.flatMap((locale) =>
    GLOSSARY_TERMS.map((entry) => ({ locale, term: entry.slugs[locale] })),
  );
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string; term: string }>;
}): Promise<Metadata> {
  const { locale, term } = await params;
  const appLocale = asAppLocale(locale);
  const entry = entryBySlug(GLOSSARY_TERMS, appLocale, term);
  if (entry === undefined) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: `marketingGlossary.terms.${entry.id}` });
  return pageMetadata({
    locale: appLocale,
    location: entryLocation('/glossary/[term]', 'term', entry),
    title: t('meta.title'),
    description: t('meta.description'),
  });
}

export default async function GlossaryTermPage({
  params,
}: {
  readonly params: Promise<{ locale: string; term: string }>;
}) {
  const { locale, term } = await params;
  const appLocale: AppLocale = asAppLocale(locale);
  const entry = entryBySlug(GLOSSARY_TERMS, appLocale, term);
  if (entry === undefined) {
    notFound();
  }
  const layout = LAYOUT[entry.id];
  if (layout === undefined) {
    notFound();
  }
  setRequestLocale(locale);
  const [t, tt, th, tl, tn] = await Promise.all([
    getTranslations(`marketingGlossary.terms.${entry.id}`),
    getTranslations('marketingGlossary.terms'),
    getTranslations('marketingGlossary.hub'),
    getTranslations('marketingGlossary.labels'),
    getTranslations('navigation.marketing'),
  ]);
  const location = entryLocation('/glossary/[term]', 'term', entry);
  const url = pageUrl(location, appLocale);
  const glossaryUrl = pageUrl(staticLocation('/glossary'), appLocale);
  const faq = FAQ_KEYS.map((key) => ({
    question: t(`faq.${key}.question`),
    answer: t(`faq.${key}.answer`),
  }));
  const facts = FACT_KEYS.map((key) => ({
    term: t(`facts.${key}.term`),
    value: t(`facts.${key}.value`),
  }));
  const related: readonly RelatedLink[] = [
    ...termsByIds(layout.related).map((item): RelatedLink => ({
      label: tt(`${item.id}.term`),
      description: tt(`${item.id}.short`),
      href: { pathname: '/glossary/[term]', params: { term: item.slugs[appLocale] } },
    })),
    {
      label: t('capability.label'),
      description: t('capability.description'),
      href: layout.capability,
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
            { name: th('breadcrumb'), url: glossaryUrl },
            { name: t('term'), url },
          ],
          extra: [
            definedTermSchema({
              origin: seoOrigin(),
              url,
              term: t('term'),
              definition: t('definition'),
              locale: appLocale,
              glossaryUrl,
              glossaryName: th('title'),
            }),
          ],
        })}
      />
      <Breadcrumbs
        label={th('breadcrumbLabel')}
        current={t('term')}
        items={[
          { label: tn('home'), href: { pathname: '/' } },
          { label: th('breadcrumb'), href: { pathname: '/glossary' } },
        ]}
      />
      <MarketingHero eyebrow={th('eyebrow')} title={t('term')} body={t('short')} />
      <Section width="content" labelledBy="definition">
        <AnswerBlock id="definition" question={t('title')} answer={t('definition')}>
          <KeyFacts items={facts} />
        </AnswerBlock>
      </Section>
      <Section width="content" labelledBy="explanation">
        <SectionHeading id="explanation" title={t('explanation.heading')} />
        <div className="mt-6">
          <Prose>
            <p>{t('explanation.p1')}</p>
            <p>{t('explanation.p2')}</p>
            <p>{t('explanation.p3')}</p>
          </Prose>
        </div>
      </Section>
      <Section width="content" labelledBy="example">
        <SectionHeading id="example" title={tl('exampleHeading')} />
        <div className="mt-6">
          <Prose>
            <p>{t('example.p1')}</p>
            <p>{t('example.p2')}</p>
          </Prose>
        </div>
      </Section>
      <Section width="content" labelledBy="velyric">
        <SectionHeading id="velyric" title={tl('velyricHeading')} />
        <div className="mt-6">
          <Prose>
            <p>{t('velyric.p1')}</p>
            <p>{t('velyric.p2')}</p>
          </Prose>
        </div>
      </Section>
      <Section width="content" labelledBy="mistake">
        <AnswerBlock id="mistake" question={t('mistake.heading')} answer={t('mistake.body')} />
      </Section>
      <Section width="content" labelledBy="faq">
        <FaqList items={faq} heading={tl('faqHeading')} headingId="faq" />
      </Section>
      <Section width="content" labelledBy="related">
        <RelatedLinks heading={tl('relatedHeading')} headingId="related" links={related} />
      </Section>
      <BottomCta />
    </>
  );
}
