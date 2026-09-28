import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MarketingHero } from '@/components/marketing/content';
import {
  AnswerBlock,
  Breadcrumbs,
  CardGrid,
  FaqList,
  Prose,
  RelatedLinks,
  Section,
  SectionHeading,
} from '@/components/marketing/sections';
import type { RelatedLink } from '@/components/marketing/sections';
import { BottomCta } from '@/components/marketing/showcase';
import { GLOSSARY_TERMS, type ContentEntry } from '@/content/collections';
import { Link } from '@/i18n/navigation';
import { asAppLocale, LOCALES, type AppLocale } from '@/i18n/routing';
import { pageUpdated } from '@/content/pages';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl } from '@/lib/seo/server';
import { staticLocation } from '@/lib/seo/urls';

interface TermGroup {
  readonly id: string;
  readonly terms: readonly string[];
}

const GROUPS: readonly TermGroup[] = [
  { id: 'voiceAi', terms: ['ai-voice-agent', 'ai-receptionist', 'ivr'] },
  { id: 'telephony', terms: ['sip', 'pstn', 'did', 'e164'] },
  { id: 'conversation', terms: ['dtmf', 'barge-in', 'warm-transfer', 'concurrent-calls'] },
  { id: 'knowledge', terms: ['rag'] },
];

const FAQ_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5'] as const;

const UPDATED = pageUpdated('/glossary');

function termsByIds(ids: readonly string[]): readonly ContentEntry[] {
  return ids
    .map((id) => GLOSSARY_TERMS.find((entry) => entry.id === id))
    .filter((entry): entry is ContentEntry => entry !== undefined);
}

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'marketingGlossary.hub' });
  return pageMetadata({
    locale: asAppLocale(locale),
    location: staticLocation('/glossary'),
    title: t('meta.title'),
    description: t('meta.description'),
  });
}

export default async function GlossaryPage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const appLocale: AppLocale = asAppLocale(locale);
  const [t, tt, tn] = await Promise.all([
    getTranslations('marketingGlossary.hub'),
    getTranslations('marketingGlossary.terms'),
    getTranslations('navigation.marketing'),
  ]);
  const location = staticLocation('/glossary');
  const faq = FAQ_KEYS.map((key) => ({
    question: t(`faq.${key}.question`),
    answer: t(`faq.${key}.answer`),
  }));
  const related: readonly RelatedLink[] = [
    {
      label: t('related.product.label'),
      description: t('related.product.description'),
      href: { pathname: '/product' },
    },
    {
      label: t('related.pricing.label'),
      description: t('related.pricing.description'),
      href: { pathname: '/pricing' },
    },
    {
      label: t('related.integrations.label'),
      description: t('related.integrations.description'),
      href: { pathname: '/integrations' },
    },
    {
      label: t('related.security.label'),
      description: t('related.security.description'),
      href: { pathname: '/security' },
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
            { name: t('breadcrumb'), url: pageUrl(location, appLocale) },
          ],
        })}
      />
      <Breadcrumbs
        label={t('breadcrumbLabel')}
        current={t('breadcrumb')}
        items={[{ label: tn('home'), href: { pathname: '/' } }]}
      />
      <MarketingHero eyebrow={t('eyebrow')} title={t('title')} body={t('body')} />
      <Section width="content" labelledBy="intro">
        <AnswerBlock id="intro" question={t('intro.heading')} answer={t('intro.answer')}>
          <Prose>
            <p>{t('intro.p1')}</p>
            <p>{t('intro.p2')}</p>
          </Prose>
        </AnswerBlock>
      </Section>
      {GROUPS.map((group) => (
        <Section key={group.id} width="wide" labelledBy={`group-${group.id}`}>
          <SectionHeading
            id={`group-${group.id}`}
            title={t(`groups.${group.id}.title`)}
            body={t(`groups.${group.id}.body`)}
          />
          <CardGrid columns={3}>
            {termsByIds(group.terms).map((entry) => (
              <Link
                key={entry.id}
                href={{
                  pathname: '/glossary/[term]',
                  params: { term: entry.slugs[appLocale] },
                }}
                className="flex h-full flex-col gap-2 rounded-xl border border-border bg-surface p-6 shadow-soft transition-colors hover:border-pink/40"
              >
                <h3 className="text-lg font-semibold text-text">{tt(`${entry.id}.term`)}</h3>
                <p className="text-sm text-text-muted">{tt(`${entry.id}.short`)}</p>
              </Link>
            ))}
          </CardGrid>
        </Section>
      ))}
      <Section width="content" labelledBy="faq">
        <FaqList items={faq} heading={t('faq.heading')} headingId="faq" />
      </Section>
      <Section width="content" labelledBy="related">
        <RelatedLinks heading={t('related.heading')} headingId="related" links={related} />
      </Section>
      <BottomCta />
    </>
  );
}
