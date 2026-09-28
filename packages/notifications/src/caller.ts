import type { NotificationLocale } from './index.js';

export type CallerNotificationType =
  | 'CALLER_BOOKING_CONFIRMATION'
  | 'CALLER_BOOKING_CHANGED'
  | 'CALLER_BOOKING_CANCELED'
  | 'CALLER_WAITLIST_OFFER';

export const CALLER_NOTIFICATION_TYPES: readonly CallerNotificationType[] = Object.freeze([
  'CALLER_BOOKING_CONFIRMATION',
  'CALLER_BOOKING_CHANGED',
  'CALLER_BOOKING_CANCELED',
  'CALLER_WAITLIST_OFFER',
]);

export const CALLER_TEMPLATE_VERSION = '2026-09-17.1';

const SHARED_PLACEHOLDERS = [
  'business_name',
  'caller_name',
  'service_name',
  'booking_date',
  'booking_time',
  'party_size',
  'location_name',
  'location_address',
  'business_phone',
] as const;

const EXTRA_PLACEHOLDERS: Readonly<Record<CallerNotificationType, readonly string[]>> = {
  CALLER_BOOKING_CONFIRMATION: ['booking_reference'],
  CALLER_BOOKING_CHANGED: ['booking_reference', 'previous_date', 'previous_time'],
  CALLER_BOOKING_CANCELED: ['booking_reference'],
  CALLER_WAITLIST_OFFER: ['offer_expires_at'],
};

export function callerPlaceholders(type: CallerNotificationType): readonly string[] {
  return [...SHARED_PLACEHOLDERS, ...EXTRA_PLACEHOLDERS[type]];
}

export function isCallerNotificationType(value: string): value is CallerNotificationType {
  return (CALLER_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export interface CallerTemplate {
  readonly subject: string;
  readonly body: string;
}

type CallerCatalog = Readonly<
  Record<CallerNotificationType, Readonly<Record<NotificationLocale, CallerTemplate>>>
>;

const CALLER_CATALOG: CallerCatalog = {
  CALLER_BOOKING_CONFIRMATION: {
    hu: {
      subject: '{{business_name}} – foglalás megerősítve ({{booking_date}})',
      body: [
        'Kedves {{caller_name}}!',
        'Köszönjük a foglalást, várjuk Önt {{booking_date}} napon {{booking_time}} órakor, {{party_size}} főre.',
        'Szolgáltatás: {{service_name}}',
        'Helyszín: {{location_name}}, {{location_address}}',
        'Ha módosítani szeretne, hívjon minket a {{business_phone}} számon.',
        'Üdvözlettel,\n{{business_name}}',
      ].join('\n\n'),
    },
    de: {
      subject: '{{business_name}} – Reservierung bestätigt ({{booking_date}})',
      body: [
        'Guten Tag {{caller_name}},',
        'vielen Dank für Ihre Reservierung. Wir erwarten Sie am {{booking_date}} um {{booking_time}} Uhr für {{party_size}} Person(en).',
        'Leistung: {{service_name}}',
        'Ort: {{location_name}}, {{location_address}}',
        'Für Änderungen erreichen Sie uns unter {{business_phone}}.',
        'Mit freundlichen Grüßen,\n{{business_name}}',
      ].join('\n\n'),
    },
    en: {
      subject: '{{business_name}} – booking confirmed ({{booking_date}})',
      body: [
        'Hello {{caller_name}},',
        'Thank you for your booking. We look forward to seeing you on {{booking_date}} at {{booking_time}} for {{party_size}} guest(s).',
        'Service: {{service_name}}',
        'Location: {{location_name}}, {{location_address}}',
        'To change anything, call us on {{business_phone}}.',
        'Kind regards,\n{{business_name}}',
      ].join('\n\n'),
    },
  },
  CALLER_BOOKING_CHANGED: {
    hu: {
      subject: '{{business_name}} – a foglalása módosult',
      body: [
        'Kedves {{caller_name}}!',
        'A foglalását módosítottuk. Új időpont: {{booking_date}} {{booking_time}}, {{party_size}} főre.',
        'Korábbi időpont: {{previous_date}} {{previous_time}}',
        'Helyszín: {{location_name}}, {{location_address}}',
        'Ha nem Ön kérte a módosítást, hívjon minket a {{business_phone}} számon.',
        'Üdvözlettel,\n{{business_name}}',
      ].join('\n\n'),
    },
    de: {
      subject: '{{business_name}} – Ihre Reservierung wurde geändert',
      body: [
        'Guten Tag {{caller_name}},',
        'Ihre Reservierung wurde geändert. Neuer Termin: {{booking_date}} um {{booking_time}} für {{party_size}} Person(en).',
        'Bisheriger Termin: {{previous_date}} {{previous_time}}',
        'Ort: {{location_name}}, {{location_address}}',
        'Falls Sie die Änderung nicht veranlasst haben, rufen Sie uns unter {{business_phone}} an.',
        'Mit freundlichen Grüßen,\n{{business_name}}',
      ].join('\n\n'),
    },
    en: {
      subject: '{{business_name}} – your booking has changed',
      body: [
        'Hello {{caller_name}},',
        'Your booking has been changed. New time: {{booking_date}} at {{booking_time}} for {{party_size}} guest(s).',
        'Previous time: {{previous_date}} {{previous_time}}',
        'Location: {{location_name}}, {{location_address}}',
        'If you did not request this change, please call us on {{business_phone}}.',
        'Kind regards,\n{{business_name}}',
      ].join('\n\n'),
    },
  },
  CALLER_BOOKING_CANCELED: {
    hu: {
      subject: '{{business_name}} – foglalás lemondva ({{booking_date}})',
      body: [
        'Kedves {{caller_name}}!',
        'A(z) {{booking_date}} {{booking_time}} időpontra szóló foglalását lemondtuk.',
        'Ha új időpontot szeretne, hívjon minket a {{business_phone}} számon, szívesen segítünk.',
        'Üdvözlettel,\n{{business_name}}',
      ].join('\n\n'),
    },
    de: {
      subject: '{{business_name}} – Reservierung storniert ({{booking_date}})',
      body: [
        'Guten Tag {{caller_name}},',
        'Ihre Reservierung für {{booking_date}} um {{booking_time}} wurde storniert.',
        'Für einen neuen Termin erreichen Sie uns gerne unter {{business_phone}}.',
        'Mit freundlichen Grüßen,\n{{business_name}}',
      ].join('\n\n'),
    },
    en: {
      subject: '{{business_name}} – booking canceled ({{booking_date}})',
      body: [
        'Hello {{caller_name}},',
        'Your booking for {{booking_date}} at {{booking_time}} has been canceled.',
        'If you would like a new time, call us on {{business_phone}} and we will be glad to help.',
        'Kind regards,\n{{business_name}}',
      ].join('\n\n'),
    },
  },
  CALLER_WAITLIST_OFFER: {
    hu: {
      subject: '{{business_name}} – felszabadult egy időpont',
      body: [
        'Kedves {{caller_name}}!',
        'Felszabadult egy időpont: {{booking_date}} {{booking_time}}, {{party_size}} főre.',
        'Az ajánlat {{offer_expires_at}} időpontig érvényes. Ha szeretné, hívjon minket a {{business_phone}} számon.',
        'Üdvözlettel,\n{{business_name}}',
      ].join('\n\n'),
    },
    de: {
      subject: '{{business_name}} – ein Termin ist frei geworden',
      body: [
        'Guten Tag {{caller_name}},',
        'ein Termin ist frei geworden: {{booking_date}} um {{booking_time}} für {{party_size}} Person(en).',
        'Das Angebot gilt bis {{offer_expires_at}}. Rufen Sie uns bei Interesse unter {{business_phone}} an.',
        'Mit freundlichen Grüßen,\n{{business_name}}',
      ].join('\n\n'),
    },
    en: {
      subject: '{{business_name}} – a slot has opened up',
      body: [
        'Hello {{caller_name}},',
        'A slot has opened up: {{booking_date}} at {{booking_time}} for {{party_size}} guest(s).',
        'The offer is valid until {{offer_expires_at}}. Call us on {{business_phone}} if you would like it.',
        'Kind regards,\n{{business_name}}',
      ].join('\n\n'),
    },
  },
};

export function defaultCallerTemplate(
  type: CallerNotificationType,
  locale: NotificationLocale,
): CallerTemplate {
  return CALLER_CATALOG[type][locale];
}

const PLACEHOLDER = /\{\{\s*([a-z_]{1,40})\s*\}\}/g;

export function unknownPlaceholders(
  type: CallerNotificationType,
  ...parts: readonly string[]
): readonly string[] {
  const allowed = new Set(callerPlaceholders(type));
  const unknown = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(PLACEHOLDER)) {
      const key = match[1] ?? '';
      if (!allowed.has(key)) {
        unknown.add(key);
      }
    }
  }
  return [...unknown].sort();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function applyPlaceholders(text: string, payload: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (_, key: string) => payload[key] ?? '');
}

function collapse(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface CallerEmailBranding {
  readonly businessName: string;
  readonly logoUrl: string | null;
  readonly color: string;
  readonly footer: string | null;
}

export interface RenderedCallerEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly templateKey: string;
  readonly templateVersion: string;
}

export function renderCallerEmail(input: {
  readonly type: CallerNotificationType;
  readonly locale: NotificationLocale;
  readonly template: CallerTemplate;
  readonly payload: Readonly<Record<string, string>>;
  readonly branding: CallerEmailBranding;
  readonly customized: boolean;
}): RenderedCallerEmail {
  const subject = collapse(applyPlaceholders(input.template.subject, input.payload)).replaceAll(
    '\n',
    ' ',
  );
  const body = collapse(applyPlaceholders(input.template.body, input.payload));
  const paragraphs = body.split('\n\n');
  const footer = input.branding.footer === null ? null : collapse(input.branding.footer);
  const text = [...paragraphs, ...(footer === null ? [] : ['', footer])].join('\n\n');
  const logo =
    input.branding.logoUrl === null
      ? `<p style="margin:0 0 24px;font-size:18px;font-weight:600;color:${escapeHtml(input.branding.color)}">${escapeHtml(input.branding.businessName)}</p>`
      : `<p style="margin:0 0 24px"><img src="${escapeHtml(input.branding.logoUrl)}" alt="${escapeHtml(input.branding.businessName)}" style="max-height:56px;max-width:220px;border:0" /></p>`;
  const html = [
    `<!doctype html><html lang="${input.locale}"><body style="margin:0;background:#F4F4F5;font-family:Inter,Arial,sans-serif;color:#111827">`,
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px">',
    `<div style="background:#ffffff;border-radius:12px;padding:32px 28px;border-top:4px solid ${escapeHtml(input.branding.color)}">`,
    logo,
    ...paragraphs.map(
      (paragraph) =>
        `<p style="margin:0 0 16px;line-height:1.6;font-size:15px">${escapeHtml(paragraph).replaceAll('\n', '<br />')}</p>`,
    ),
    '</div>',
    footer === null
      ? ''
      : `<p style="margin:20px 4px 0;color:#6B7280;font-size:12px;line-height:1.5">${escapeHtml(footer).replaceAll('\n', '<br />')}</p>`,
    '</div></body></html>',
  ].join('');
  return {
    subject,
    text,
    html,
    templateKey: `${input.type.toLowerCase()}.${input.locale}${input.customized ? '.custom' : ''}`,
    templateVersion: CALLER_TEMPLATE_VERSION,
  };
}

const CALLER_SMS: Readonly<
  Record<CallerNotificationType, Readonly<Record<NotificationLocale, string>>>
> = {
  CALLER_BOOKING_CONFIRMATION: {
    hu: '{{business_name}}: foglalását rögzítettük {{booking_date}} {{booking_time}}, {{party_size}} főre. Azonosító: {{booking_reference}}. Módosítás: {{business_phone}}',
    de: '{{business_name}}: Ihre Reservierung am {{booking_date}} um {{booking_time}} für {{party_size}} Person(en) ist bestätigt. Nummer: {{booking_reference}}. Änderungen: {{business_phone}}',
    en: '{{business_name}}: your booking on {{booking_date}} at {{booking_time}} for {{party_size}} is confirmed. Reference: {{booking_reference}}. Changes: {{business_phone}}',
  },
  CALLER_BOOKING_CHANGED: {
    hu: '{{business_name}}: foglalása módosult. Új időpont: {{booking_date}} {{booking_time}}, {{party_size}} főre. Kérdés esetén: {{business_phone}}',
    de: '{{business_name}}: Ihre Reservierung wurde geändert. Neuer Termin: {{booking_date}} um {{booking_time}} für {{party_size}} Person(en). Fragen: {{business_phone}}',
    en: '{{business_name}}: your booking has changed. New time: {{booking_date}} at {{booking_time}} for {{party_size}}. Questions: {{business_phone}}',
  },
  CALLER_BOOKING_CANCELED: {
    hu: '{{business_name}}: a(z) {{booking_date}} {{booking_time}} foglalását lemondtuk. Új időponthoz hívjon: {{business_phone}}',
    de: '{{business_name}}: Ihre Reservierung am {{booking_date}} um {{booking_time}} wurde storniert. Neuer Termin: {{business_phone}}',
    en: '{{business_name}}: your booking on {{booking_date}} at {{booking_time}} has been canceled. For a new time call {{business_phone}}',
  },
  CALLER_WAITLIST_OFFER: {
    hu: '{{business_name}}: felszabadult egy időpont {{booking_date}} {{booking_time}}, {{party_size}} főre. {{offer_expires_at}}-ig foglalhat: {{business_phone}}',
    de: '{{business_name}}: frei geworden: {{booking_date}} um {{booking_time}} für {{party_size}} Person(en). Bis {{offer_expires_at}} buchbar unter {{business_phone}}',
    en: '{{business_name}}: a slot opened up on {{booking_date}} at {{booking_time}} for {{party_size}}. Book by {{offer_expires_at}} on {{business_phone}}',
  },
};

export const CALLER_SMS_MAX_LENGTH = 480;

export function renderCallerSms(
  type: CallerNotificationType,
  locale: NotificationLocale,
  payload: Readonly<Record<string, string>>,
): string {
  const text = applyPlaceholders(CALLER_SMS[type][locale], payload).replace(/\s+/g, ' ').trim();
  return text.length <= CALLER_SMS_MAX_LENGTH
    ? text
    : `${text.slice(0, CALLER_SMS_MAX_LENGTH - 1).trimEnd()}…`;
}
