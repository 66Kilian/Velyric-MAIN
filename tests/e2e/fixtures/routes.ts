export type PublicLocale = 'hu' | 'de' | 'en';

const STATIC_PATHS: Readonly<Record<string, Readonly<Record<PublicLocale, string>>>> = {
  home: { en: '', hu: '', de: '' },
  product: { en: '/ai-voice-agents', hu: '/ai-hangasszisztens', de: '/ki-telefonassistent' },
  receptionist: { en: '/ai-receptionist', hu: '/ai-recepcios', de: '/ki-rezeptionist' },
  booking: {
    en: '/ai-appointment-booking',
    hu: '/telefonos-idopontfoglalas',
    de: '/ki-terminbuchung',
  },
  multilingual: {
    en: '/multilingual-ai-voice-agents',
    hu: '/tobbnyelvu-ai-hangasszisztens',
    de: '/mehrsprachige-ki-telefonassistenten',
  },
  transfer: {
    en: '/ai-call-transfer',
    hu: '/hivasatadas-munkatarsnak',
    de: '/ki-anrufweiterleitung',
  },
  pricing: { en: '/pricing', hu: '/arak', de: '/preise' },
  integrations: { en: '/integrations', hu: '/integraciok', de: '/integrationen' },
  security: { en: '/security', hu: '/biztonsag', de: '/sicherheit' },
  docs: { en: '/docs', hu: '/dokumentacio', de: '/dokumentation' },
  glossary: { en: '/glossary', hu: '/fogalomtar', de: '/glossar' },
  contact: { en: '/contact', hu: '/kapcsolat', de: '/kontakt' },
  login: { en: '/login', hu: '/login', de: '/login' },
  signup: { en: '/signup', hu: '/signup', de: '/signup' },
  restaurant: {
    en: '/solutions/restaurants',
    hu: '/megoldasok/ettermek',
    de: '/loesungen/restaurants',
  },
  dental: {
    en: '/solutions/dental-clinics',
    hu: '/megoldasok/fogaszati-rendelo',
    de: '/loesungen/zahnarztpraxen',
  },
  googleCalendar: {
    en: '/integrations/google-calendar',
    hu: '/integraciok/google-naptar',
    de: '/integrationen/google-kalender',
  },
  webhooks: {
    en: '/integrations/webhooks',
    hu: '/integraciok/webhookok',
    de: '/integrationen/webhooks',
  },
  compareIvr: {
    en: '/compare/ai-voice-agent-vs-ivr',
    hu: '/osszehasonlitas/ai-hangasszisztens-vagy-ivr',
    de: '/vergleich/ki-telefonassistent-vs-ivr',
  },
  glossaryTerm: {
    en: '/glossary/ai-receptionist',
    hu: '/fogalomtar/ai-recepcios',
    de: '/glossar/ki-rezeptionist',
  },
};

export function localizedPath(key: keyof typeof STATIC_PATHS, locale: PublicLocale): string {
  const entry = STATIC_PATHS[key];
  return `/${locale}${entry === undefined ? '' : entry[locale]}`;
}

export function publicPaths(locale: PublicLocale): readonly string[] {
  return Object.values(STATIC_PATHS).map((entry) => `/${locale}${entry[locale]}`);
}

export function indexablePaths(locale: PublicLocale): readonly string[] {
  return Object.entries(STATIC_PATHS)
    .filter(([key]) => key !== 'login' && key !== 'signup')
    .map(([, entry]) => `/${locale}${entry[locale]}`);
}
