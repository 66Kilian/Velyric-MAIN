import type { AppLocale } from './routing';

type Tree = { readonly [key: string]: string | Tree };

const loaders: Readonly<Record<string, (locale: AppLocale) => Promise<{ default: Tree }>>> = {
  admin: (locale) => import(`@velyric/i18n/messages/${locale}/admin.json`),
  common: (locale) => import(`@velyric/i18n/messages/${locale}/common.json`),
  errors: (locale) => import(`@velyric/i18n/messages/${locale}/errors.json`),
  enums: (locale) => import(`@velyric/i18n/messages/${locale}/enums.json`),
  navigation: (locale) => import(`@velyric/i18n/messages/${locale}/navigation.json`),
  marketing: (locale) => import(`@velyric/i18n/messages/${locale}/marketing.json`),
  legal: (locale) => import(`@velyric/i18n/messages/${locale}/legal.json`),
  auth: (locale) => import(`@velyric/i18n/messages/${locale}/auth.json`),
  checkout: (locale) => import(`@velyric/i18n/messages/${locale}/checkout.json`),
  onboarding: (locale) => import(`@velyric/i18n/messages/${locale}/onboarding.json`),
  dashboard: (locale) => import(`@velyric/i18n/messages/${locale}/dashboard.json`),
  calls: (locale) => import(`@velyric/i18n/messages/${locale}/calls.json`),
  agents: (locale) => import(`@velyric/i18n/messages/${locale}/agents.json`),
  knowledge: (locale) => import(`@velyric/i18n/messages/${locale}/knowledge.json`),
  bookings: (locale) => import(`@velyric/i18n/messages/${locale}/bookings.json`),
  integrations: (locale) => import(`@velyric/i18n/messages/${locale}/integrations.json`),
  analytics: (locale) => import(`@velyric/i18n/messages/${locale}/analytics.json`),
  phoneNumbers: (locale) => import(`@velyric/i18n/messages/${locale}/phoneNumbers.json`),
  locations: (locale) => import(`@velyric/i18n/messages/${locale}/locations.json`),
  simulation: (locale) => import(`@velyric/i18n/messages/${locale}/simulation.json`),
  contacts: (locale) => import(`@velyric/i18n/messages/${locale}/contacts.json`),
  billing: (locale) => import(`@velyric/i18n/messages/${locale}/billing.json`),
  support: (locale) => import(`@velyric/i18n/messages/${locale}/support.json`),
  settings: (locale) => import(`@velyric/i18n/messages/${locale}/settings.json`),
  security: (locale) => import(`@velyric/i18n/messages/${locale}/security.json`),
  marketingCapabilities: (locale) => import(`@velyric/i18n/messages/${locale}/marketingCapabilities.json`),
  marketingIntegrations: (locale) => import(`@velyric/i18n/messages/${locale}/marketingIntegrations.json`),
  marketingCompare: (locale) => import(`@velyric/i18n/messages/${locale}/marketingCompare.json`),
  marketingGlossary: (locale) => import(`@velyric/i18n/messages/${locale}/marketingGlossary.json`),
  marketingContact: (locale) => import(`@velyric/i18n/messages/${locale}/marketingContact.json`),
};

export async function loadMessages(locale: AppLocale): Promise<Record<string, Tree>> {
  const entries = await Promise.all(
    Object.entries(loaders).map(async ([namespace, load]) => {
      try {
        return [namespace, (await load(locale)).default] as const;
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, Tree] => entry !== null),
  );
}
