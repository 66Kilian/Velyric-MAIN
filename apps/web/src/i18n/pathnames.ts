export const PATHNAMES = {
  '/': '/',
  '/product': { en: '/ai-voice-agents', hu: '/ai-hangasszisztens', de: '/ki-telefonassistent' },
  '/ai-receptionist': {
    en: '/ai-receptionist',
    hu: '/ai-recepcios',
    de: '/ki-rezeptionist',
  },
  '/appointment-booking': {
    en: '/ai-appointment-booking',
    hu: '/telefonos-idopontfoglalas',
    de: '/ki-terminbuchung',
  },
  '/multilingual': {
    en: '/multilingual-ai-voice-agents',
    hu: '/tobbnyelvu-ai-hangasszisztens',
    de: '/mehrsprachige-ki-telefonassistenten',
  },
  '/call-transfer': {
    en: '/ai-call-transfer',
    hu: '/hivasatadas-munkatarsnak',
    de: '/ki-anrufweiterleitung',
  },
  '/solutions/[vertical]': {
    en: '/solutions/[vertical]',
    hu: '/megoldasok/[vertical]',
    de: '/loesungen/[vertical]',
  },
  '/integrations': { en: '/integrations', hu: '/integraciok', de: '/integrationen' },
  '/integrations/[integration]': {
    en: '/integrations/[integration]',
    hu: '/integraciok/[integration]',
    de: '/integrationen/[integration]',
  },
  '/compare/[comparison]': {
    en: '/compare/[comparison]',
    hu: '/osszehasonlitas/[comparison]',
    de: '/vergleich/[comparison]',
  },
  '/glossary': { en: '/glossary', hu: '/fogalomtar', de: '/glossar' },
  '/glossary/[term]': {
    en: '/glossary/[term]',
    hu: '/fogalomtar/[term]',
    de: '/glossar/[term]',
  },
  '/pricing': { en: '/pricing', hu: '/arak', de: '/preise' },
  '/security': { en: '/security', hu: '/biztonsag', de: '/sicherheit' },
  '/docs': { en: '/docs', hu: '/dokumentacio', de: '/dokumentation' },
  '/contact': { en: '/contact', hu: '/kapcsolat', de: '/kontakt' },
  '/login': '/login',
  '/signup': '/signup',
  '/invite/[tenant]/[id]': '/invite/[tenant]/[id]',
} as const;

export type AppPathname = keyof typeof PATHNAMES;
