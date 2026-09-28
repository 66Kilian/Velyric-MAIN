import { KeyRound, ListChecks, Workflow } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MarketingHero } from '@/components/marketing/content';
import {
  AnswerBlock,
  Breadcrumbs,
  CardGrid,
  FaqList,
  FeatureCard,
  KeyFacts,
  RelatedLinks,
  Section,
  SectionHeading,
  StepList,
  type RelatedLink,
} from '@/components/marketing/sections';
import { BottomCta } from '@/components/marketing/showcase';
import { entryBySlug, INTEGRATIONS } from '@/content/collections';
import { asAppLocale, LOCALES, type AppLocale } from '@/i18n/routing';
import { JsonLd } from '@/lib/seo/json-ld';
import { pageGraph, pageMetadata, pageUrl } from '@/lib/seo/server';
import { entryLocation, staticLocation } from '@/lib/seo/urls';

const STEP_KEYS = ['s1', 's2', 's3', 's4'] as const;
const ACTION_KEYS = ['a1', 'a2', 'a3'] as const;
const SECURITY_KEYS = ['i1', 'i2', 'i3', 'i4'] as const;
const LIMIT_KEYS = ['l1', 'l2', 'l3'] as const;
const FAQ_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5'] as const;

type RelatedTarget =
  | { readonly kind: 'static'; readonly href: RelatedLink['href'] }
  | { readonly kind: 'integration'; readonly id: string };

const RELATED_TARGETS: Readonly<Record<string, readonly RelatedTarget[]>> = {
  'google-calendar': [
    { kind: 'static', href: { pathname: '/appointment-booking' } },
    { kind: 'integration', id: 'microsoft-365' },
  ],
  'microsoft-365': [
    { kind: 'integration', id: 'google-calendar' },
    { kind: 'static', href: { pathname: '/appointment-booking' } },
  ],
  'custom-api-tools': [
    { kind: 'integration', id: 'webhooks' },
    { kind: 'static', href: { pathname: '/docs' } },
  ],
  webhooks: [
    { kind: 'integration', id: 'custom-api-tools' },
    { kind: 'static', href: { pathname: '/docs' } },
  ],
  'phone-numbers': [
    { kind: 'static', href: { pathname: '/ai-receptionist' } },
    { kind: 'static', href: { pathname: '/pricing' } },
  ],
  'email-notifications': [
    { kind: 'static', href: { pathname: '/appointment-booking' } },
    { kind: 'static', href: { pathname: '/security' } },
  ],
};

function relatedHref(entryId: string, index: number, locale: AppLocale): RelatedLink['href'] {
  const target = (RELATED_TARGETS[entryId] ?? [])[index];
  if (target === undefined) {
    return { pathname: '/integrations' };
  }
  if (target.kind === 'static') {
    return target.href;
  }
  const entry = INTEGRATIONS.find((item) => item.id === target.id);
  return entry === undefined
    ? { pathname: '/integrations' }
    : { pathname: '/integrations/[integration]', params: { integration: entry.slugs[locale] } };
}

export function generateStaticParams() {
  return LOCALES.flatMap((locale) =>
    INTEGRATIONS.map((entry) => ({ locale, integration: entry.slugs[locale] })),
  );
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ locale: string; integration: string }>;
}): Promise<Metadata> {
  const { locale, integration } = await params;
  const appLocale = asAppLocale(locale);
  const entry = entryBySlug(INTEGRATIONS, appLocale, integration);
  if (entry === undefined) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: `marketingIntegrations.${entry.id}` });
  return pageMetadata({
    locale: appLocale,
    location: entryLocation('/integrations/[integration]', 'integration', entry),
    title: t('meta.title'),
    description: t('meta.description'),
  });
}

export default async function IntegrationPage({
  params,
}: {
  readonly params: Promise<{ locale: string; integration: string }>;
}) {
  const { locale, integration } = await params;
  const appLocale = asAppLocale(locale);
  const entry = entryBySlug(INTEGRATIONS, appLocale, integration);
  if (entry === undefined) {
    notFound();
  }
  setRequestLocale(locale);
  const [t, tc, tn] = await Promise.all([
    getTranslations(`marketingIntegrations.${entry.id}`),
    getTranslations('marketingIntegrations.common'),
    getTranslations('navigation.marketing'),
  ]);
  const location = entryLocation('/integrations/[integration]', 'integration', entry);
  const faq = FAQ_KEYS.map((key) => ({
    question: t(`faq.${key}.question`),
    answer: t(`faq.${key}.answer`),
  }));
  const related: RelatedLink[] = (['r1', 'r2'] as const).map((key, index) => ({
    label: t(`related.${key}.label`),
    description: t(`related.${key}.description`),
    href: relatedHref(entry.id, index, appLocale),
  }));
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
            { name: tn('integrations'), url: pageUrl(staticLocation('/integrations'), appLocale) },
            { name: t('title'), url: pageUrl(location, appLocale) },
          ],
        })}
      />
      <Breadcrumbs
        label={tc('breadcrumbLabel')}
        current={t('title')}
        items={[
          { label: tn('home'), href: { pathname: '/' } },
          { label: tn('integrations'), href: { pathname: '/integrations' } },
        ]}
      />
      <MarketingHero eyebrow={t('eyebrow')} title={t('title')} body={t('body')} />
      <Section width="content" labelledBy="integration-answer">
        <AnswerBlock
          id="integration-answer"
          question={t('answer.question')}
          answer={t('answer.body')}
        />
        <KeyFacts
          items={[
            { term: tc('labels.auth'), value: t('facts.auth') },
            { term: tc('labels.direction'), value: t('facts.direction') },
            { term: tc('labels.operations'), value: t('facts.operations') },
            { term: tc('labels.surface'), value: t('facts.surface') },
          ]}
        />
      </Section>
      <Section width="content" labelledBy="integration-setup">
        <SectionHeading
          id="integration-setup"
          title={t('setup.heading')}
          body={t('setup.body')}
        />
        <StepList
          steps={STEP_KEYS.map((key) => ({
            title: t(`setup.steps.${key}.title`),
            body: t(`setup.steps.${key}.body`),
          }))}
        />
      </Section>
      <Section width="wide" labelledBy="integration-actions">
        <SectionHeading
          id="integration-actions"
          title={t('actions.heading')}
          body={t('actions.body')}
        />
        <CardGrid columns={3}>
          {ACTION_KEYS.map((key, index) => (
            <FeatureCard
              key={key}
              title={t(`actions.items.${key}.title`)}
              body={t(`actions.items.${key}.body`)}
              icon={
                index === 0 ? (
                  <ListChecks className="h-5 w-5" aria-hidden="true" />
                ) : index === 1 ? (
                  <Workflow className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <KeyRound className="h-5 w-5" aria-hidden="true" />
                )
              }
            />
          ))}
        </CardGrid>
      </Section>
      <Section width="content" labelledBy="integration-security">
        <SectionHeading
          id="integration-security"
          title={t('security.heading')}
          body={t('security.body')}
        />
        <ul className="mt-6 flex flex-col gap-3 text-[15px] leading-relaxed text-text-muted">
          {SECURITY_KEYS.map((key) => (
            <li key={key} className="flex gap-3">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-pink" aria-hidden="true" />
              {t(`security.items.${key}`)}
            </li>
          ))}
        </ul>
      </Section>
      <Section width="content" labelledBy="integration-limits">
        <SectionHeading id="integration-limits" title={t('limits.heading')} />
        <ul className="mt-6 flex flex-col gap-3 text-[15px] leading-relaxed text-text-muted">
          {LIMIT_KEYS.map((key) => (
            <li key={key} className="flex gap-3">
              <span
                className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted"
                aria-hidden="true"
              />
              {t(`limits.items.${key}`)}
            </li>
          ))}
        </ul>
      </Section>
      <Section width="content" labelledBy="integration-faq">
        <FaqList items={faq} heading={tc('faqHeading')} headingId="integration-faq" />
      </Section>
      <Section width="wide" labelledBy="integration-related">
        <RelatedLinks
          heading={tc('relatedHeading')}
          headingId="integration-related"
          links={related}
        />
      </Section>
      <BottomCta />
    </>
  );
}
