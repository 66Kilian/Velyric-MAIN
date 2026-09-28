import type { AppLocale } from '@/i18n/routing';

export interface ContentEntry {
  readonly id: string;
  readonly slugs: Readonly<Record<AppLocale, string>>;
  readonly updated: string;
}

export const VERTICALS: readonly ContentEntry[] = [
  {
    id: 'restaurant',
    slugs: { en: 'restaurants', hu: 'ettermek', de: 'restaurants' },
    updated: '2026-09-16',
  },
  {
    id: 'dental-clinic',
    slugs: { en: 'dental-clinics', hu: 'fogaszati-rendelo', de: 'zahnarztpraxen' },
    updated: '2026-09-16',
  },
  {
    id: 'auto-service',
    slugs: { en: 'auto-repair-shops', hu: 'autoszerviz', de: 'autowerkstatt' },
    updated: '2026-09-16',
  },
  {
    id: 'car-detailing',
    slugs: { en: 'car-detailing', hu: 'autokozmetika', de: 'fahrzeugaufbereitung' },
    updated: '2026-09-16',
  },
  {
    id: 'salon',
    slugs: {
      en: 'hair-and-beauty-salons',
      hu: 'fodraszat-es-szepsegszalon',
      de: 'friseur-und-kosmetiksalons',
    },
    updated: '2026-09-16',
  },
  {
    id: 'hotel',
    slugs: {
      en: 'hotels-and-accommodation',
      hu: 'szallashelyek',
      de: 'hotels-und-unterkuenfte',
    },
    updated: '2026-09-16',
  },
  {
    id: 'real-estate',
    slugs: { en: 'real-estate-agencies', hu: 'ingatlanirodak', de: 'immobilienbueros' },
    updated: '2026-09-16',
  },
  {
    id: 'webshop',
    slugs: { en: 'online-stores', hu: 'webaruhazak', de: 'onlineshops' },
    updated: '2026-09-16',
  },
  {
    id: 'b2b-support',
    slugs: {
      en: 'b2b-customer-support',
      hu: 'b2b-ugyfelszolgalat',
      de: 'b2b-kundenservice',
    },
    updated: '2026-09-16',
  },
];

export const INTEGRATIONS: readonly ContentEntry[] = [
  {
    id: 'google-calendar',
    slugs: { en: 'google-calendar', hu: 'google-naptar', de: 'google-kalender' },
    updated: '2026-09-16',
  },
  {
    id: 'microsoft-365',
    slugs: { en: 'microsoft-365', hu: 'microsoft-365', de: 'microsoft-365' },
    updated: '2026-09-16',
  },
  {
    id: 'custom-api-tools',
    slugs: { en: 'custom-api-tools', hu: 'sajat-api-eszkozok', de: 'eigene-api-tools' },
    updated: '2026-09-16',
  },
  {
    id: 'webhooks',
    slugs: { en: 'webhooks', hu: 'webhookok', de: 'webhooks' },
    updated: '2026-09-16',
  },
  {
    id: 'phone-numbers',
    slugs: { en: 'phone-numbers', hu: 'telefonszamok', de: 'rufnummern' },
    updated: '2026-09-16',
  },
  {
    id: 'email-notifications',
    slugs: { en: 'email-notifications', hu: 'email-ertesitesek', de: 'e-mail-benachrichtigungen' },
    updated: '2026-09-16',
  },
];

export const COMPARISONS: readonly ContentEntry[] = [
  {
    id: 'vs-call-center',
    slugs: {
      en: 'ai-receptionist-vs-call-center',
      hu: 'ai-recepcios-vagy-call-center',
      de: 'ki-rezeptionist-vs-callcenter',
    },
    updated: '2026-09-16',
  },
  {
    id: 'vs-ivr',
    slugs: {
      en: 'ai-voice-agent-vs-ivr',
      hu: 'ai-hangasszisztens-vagy-ivr',
      de: 'ki-telefonassistent-vs-ivr',
    },
    updated: '2026-09-16',
  },
  {
    id: 'vs-voicemail',
    slugs: {
      en: 'ai-receptionist-vs-voicemail',
      hu: 'ai-recepcios-vagy-hangposta',
      de: 'ki-rezeptionist-vs-anrufbeantworter',
    },
    updated: '2026-09-16',
  },
];

export const GLOSSARY_TERMS: readonly ContentEntry[] = [
  {
    id: 'ai-voice-agent',
    slugs: { en: 'ai-voice-agent', hu: 'ai-hangasszisztens', de: 'ki-telefonassistent' },
    updated: '2026-09-16',
  },
  {
    id: 'ai-receptionist',
    slugs: { en: 'ai-receptionist', hu: 'ai-recepcios', de: 'ki-rezeptionist' },
    updated: '2026-09-16',
  },
  {
    id: 'ivr',
    slugs: { en: 'ivr', hu: 'ivr-hangmenu', de: 'ivr' },
    updated: '2026-09-16',
  },
  {
    id: 'sip',
    slugs: { en: 'sip', hu: 'sip', de: 'sip' },
    updated: '2026-09-16',
  },
  {
    id: 'pstn',
    slugs: { en: 'pstn', hu: 'pstn', de: 'pstn' },
    updated: '2026-09-16',
  },
  {
    id: 'did',
    slugs: { en: 'did-phone-number', hu: 'did-telefonszam', de: 'did-rufnummer' },
    updated: '2026-09-16',
  },
  {
    id: 'dtmf',
    slugs: { en: 'dtmf', hu: 'dtmf', de: 'dtmf' },
    updated: '2026-09-16',
  },
  {
    id: 'barge-in',
    slugs: { en: 'barge-in', hu: 'kozbevagas-barge-in', de: 'barge-in' },
    updated: '2026-09-16',
  },
  {
    id: 'warm-transfer',
    slugs: { en: 'warm-transfer', hu: 'meleg-hivasatadas', de: 'warme-weiterleitung' },
    updated: '2026-09-16',
  },
  {
    id: 'e164',
    slugs: {
      en: 'e164-phone-number-format',
      hu: 'e164-telefonszam-formatum',
      de: 'e164-rufnummernformat',
    },
    updated: '2026-09-16',
  },
  {
    id: 'concurrent-calls',
    slugs: { en: 'concurrent-calls', hu: 'parhuzamos-hivasok', de: 'gleichzeitige-anrufe' },
    updated: '2026-09-16',
  },
  {
    id: 'rag',
    slugs: {
      en: 'retrieval-augmented-generation',
      hu: 'rag-tudasbazis-kereses',
      de: 'retrieval-augmented-generation',
    },
    updated: '2026-09-16',
  },
];

export function entryBySlug(
  entries: readonly ContentEntry[],
  locale: AppLocale,
  slug: string,
): ContentEntry | undefined {
  return entries.find((entry) => entry.slugs[locale] === slug);
}
