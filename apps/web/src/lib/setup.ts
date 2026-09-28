import type { AgentConfig, AgentLocale } from '@velyric/contracts';
import { defaultAgentConfig, disclosureVersion, languageDefaults } from '@/lib/agent-defaults';
import type { ProvisioningStatus } from '@/lib/api/provisioning';
import type { ScenarioAssertion, ScenarioDefinition } from '@/lib/api/simulation';

export const SETUP_STEPS = [
  'business',
  'voice',
  'knowledge',
  'bookings',
  'calls',
  'launch',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export const VOICE_PERSONAS = [
  { key: 'mark', voice: 'cedar', orb: 'blue', names: { hu: 'Márk', en: 'Mark', de: 'Mark' } },
  { key: 'anna', voice: 'marin', orb: 'violet', names: { hu: 'Anna', en: 'Anna', de: 'Anna' } },
  { key: 'lili', voice: 'coral', orb: 'peach', names: { hu: 'Lili', en: 'Lily', de: 'Lili' } },
  { key: 'bence', voice: 'ash', orb: 'emerald', names: { hu: 'Bence', en: 'Ben', de: 'Ben' } },
  {
    key: 'zsofi',
    voice: 'shimmer',
    orb: 'rose',
    names: { hu: 'Zsófi', en: 'Sophie', de: 'Sophie' },
  },
  { key: 'david', voice: 'echo', orb: 'indigo', names: { hu: 'Dávid', en: 'David', de: 'David' } },
  {
    key: 'eszter',
    voice: 'sage',
    orb: 'teal',
    names: { hu: 'Eszter', en: 'Esther', de: 'Esther' },
  },
  { key: 'gergo', voice: 'verse', orb: 'amber', names: { hu: 'Gergő', en: 'Greg', de: 'Gregor' } },
] as const;
export type VoicePersonaKey = (typeof VOICE_PERSONAS)[number]['key'];
export type OrbTone = (typeof VOICE_PERSONAS)[number]['orb'];
export const RECOMMENDED_PERSONA: VoicePersonaKey = 'anna';

export const CONVERSATION_STYLES = ['friendly', 'professional', 'energetic'] as const;
export type ConversationStyle = (typeof CONVERSATION_STYLES)[number];
export const ADDRESSING = ['formal', 'informal'] as const;
export type Addressing = (typeof ADDRESSING)[number];
export const PACES = ['calm', 'natural', 'dynamic'] as const;
export type Pace = (typeof PACES)[number];
export const AFTER_HOURS = ['TAKE_MESSAGE', 'CALLBACK_REQUEST', 'TRANSFER_ON_CALL'] as const;
export type AfterHoursChoice = (typeof AFTER_HOURS)[number];
export const NO_ANSWER = ['CALLBACK_REQUEST', 'RETURN_TO_AI'] as const;
export type NoAnswerChoice = (typeof NO_ANSWER)[number];
export const AGENT_LOCALES: readonly AgentLocale[] = ['hu', 'en', 'de'];
export const DURATIONS = [15, 30, 45, 60, 90, 120, 180] as const;
export const HANDOFF_LABEL = 'reception';

export interface HoursRow {
  readonly iso_weekday: number;
  readonly open: boolean;
  readonly opens: string;
  readonly closes: string;
}

export interface QaPair {
  readonly question: string;
  readonly answer: string;
}

export interface SetupDraft {
  readonly businessName: string;
  readonly website: string;
  readonly reception: boolean;
  readonly bookings: boolean;
  readonly address: string;
  readonly defaultLocale: AgentLocale;
  readonly persona: VoicePersonaKey;
  readonly style: ConversationStyle;
  readonly addressing: Addressing;
  readonly pace: Pace;
  readonly greeting: string;
  readonly greetingEdited: boolean;
  readonly hours: readonly HoursRow[];
  readonly qa: readonly QaPair[];
  readonly serviceName: string;
  readonly durationMinutes: number;
  readonly minParty: number;
  readonly maxParty: number;
  readonly capacity: number;
  readonly bufferMinutes: number;
  readonly cancellationHours: number;
  readonly transferNumber: string;
  readonly afterHours: AfterHoursChoice;
  readonly noAnswer: NoAnswerChoice;
  readonly maxCallMinutes: number;
  readonly recording: boolean;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
}

export interface ParsedAddress {
  readonly line1: string;
  readonly city: string;
  readonly postal_code: string;
}

const PREFIX_FIRST = /^\s*(\d{4,5})\s+([^,]+?)\s*,\s*(.+?)\s*$/;
const STREET_FIRST = /^\s*(.+?)\s*,\s*(\d{4,5})\s+(.+?)\s*$/;

export function parseAddress(value: string): ParsedAddress | null {
  const prefixed = PREFIX_FIRST.exec(value);
  if (prefixed?.[1] !== undefined && prefixed[2] !== undefined && prefixed[3] !== undefined) {
    return { postal_code: prefixed[1], city: prefixed[2], line1: prefixed[3] };
  }
  const street = STREET_FIRST.exec(value);
  if (street?.[1] !== undefined && street[2] !== undefined && street[3] !== undefined) {
    return { line1: street[1], postal_code: street[2], city: street[3] };
  }
  return null;
}

export function formatAddress(
  address: { readonly line1: string; readonly city: string; readonly postal_code: string } | null,
): string {
  return address === null ? '' : `${address.postal_code} ${address.city}, ${address.line1}`;
}

const COUNTRY_CODES: Readonly<Record<string, string>> = {
  HU: '36',
  AT: '43',
  DE: '49',
  CH: '41',
  SK: '421',
  RO: '40',
  SI: '386',
  HR: '385',
  CZ: '420',
  PL: '48',
};

export function normalizePhone(value: string, country: string): string | null {
  let digits = value.replace(/[\s()./-]/g, '');
  if (digits === '') {
    return null;
  }
  if (digits.startsWith('00')) {
    digits = `+${digits.slice(2)}`;
  } else if (country === 'HU' && digits.startsWith('06')) {
    digits = `+36${digits.slice(2)}`;
  } else if (digits.startsWith('0') && COUNTRY_CODES[country] !== undefined) {
    digits = `+${COUNTRY_CODES[country]}${digits.slice(1)}`;
  }
  return /^\+[1-9][0-9]{6,14}$/.test(digits) ? digits : null;
}

export function normalizeWebsite(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.includes('.') ? url.toString() : null;
  } catch {
    return null;
  }
}

export function personaOf(key: VoicePersonaKey): (typeof VOICE_PERSONAS)[number] {
  return VOICE_PERSONAS.find((entry) => entry.key === key) ?? VOICE_PERSONAS[1];
}

export function personaName(key: VoicePersonaKey, locale: AgentLocale): string {
  return personaOf(key).names[locale];
}

function hungarianArticle(value: string): string {
  return /^[aáeéiíoóöőuúüű]/i.test(value.trim()) ? 'Az' : 'A';
}

export function suggestedGreeting(
  locale: AgentLocale,
  businessName: string,
  persona: VoicePersonaKey,
  addressing: Addressing,
): string {
  const name = personaName(persona, locale);
  const business = businessName.trim();
  if (locale === 'hu') {
    const opening = addressing === 'formal' ? 'Jó napot kívánok!' : 'Szia!';
    const help = addressing === 'formal' ? 'Miben segíthetek?' : 'Miben segíthetek neked?';
    return `${opening} ${hungarianArticle(business)} ${business} AI-asszisztense, ${name} vagyok. ${help}`;
  }
  if (locale === 'de') {
    return addressing === 'formal'
      ? `Guten Tag! Hier ist ${name}, die KI-Assistenz von ${business}. Wie kann ich Ihnen helfen?`
      : `Hallo! Hier ist ${name}, die KI-Assistenz von ${business}. Wie kann ich dir helfen?`;
  }
  return `Hello! This is ${name}, the AI assistant of ${business}. How can I help you today?`;
}

const STYLE_PERSONA: Readonly<Record<ConversationStyle, AgentConfig['persona']>> = {
  friendly: {
    warmth: 80,
    formality: 60,
    energy: 50,
    pace: 50,
    brevity: 60,
    empathy: 75,
    humor: 15,
    assertiveness: 35,
  },
  professional: {
    warmth: 55,
    formality: 70,
    energy: 40,
    pace: 50,
    brevity: 70,
    empathy: 60,
    humor: 5,
    assertiveness: 50,
  },
  energetic: {
    warmth: 75,
    formality: 55,
    energy: 80,
    pace: 50,
    brevity: 60,
    empathy: 65,
    humor: 25,
    assertiveness: 50,
  },
};

const PACE_VALUE: Readonly<Record<Pace, number>> = { calm: 35, natural: 50, dynamic: 70 };

export function styleFromPersona(persona: AgentConfig['persona']): ConversationStyle {
  if (persona.energy >= 70) {
    return 'energetic';
  }
  return persona.warmth >= 70 ? 'friendly' : 'professional';
}

export function paceFromPersona(persona: AgentConfig['persona']): Pace {
  return persona.pace <= 40 ? 'calm' : persona.pace >= 65 ? 'dynamic' : 'natural';
}

export function defaultHours(): HoursRow[] {
  return [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    iso_weekday: day,
    open: day <= 5,
    opens: '08:00',
    closes: '17:00',
  }));
}

export function hoursFromEntries(
  entries: readonly {
    readonly iso_weekday: number;
    readonly opens: string;
    readonly closes: string;
  }[],
): HoursRow[] {
  if (entries.length === 0) {
    return defaultHours();
  }
  return [1, 2, 3, 4, 5, 6, 7].map((day) => {
    const entry = entries.find((candidate) => candidate.iso_weekday === day);
    return entry === undefined
      ? { iso_weekday: day, open: false, opens: '08:00', closes: '17:00' }
      : { iso_weekday: day, open: true, opens: entry.opens, closes: entry.closes };
  });
}

export function openHours(hours: readonly HoursRow[]): {
  iso_weekday: number;
  opens: string;
  closes: string;
}[] {
  return hours
    .filter((row) => row.open && row.closes > row.opens)
    .map((row) => ({ iso_weekday: row.iso_weekday, opens: row.opens, closes: row.closes }));
}

export function buildAgentConfig(
  draft: SetupDraft,
  base: AgentConfig | null,
  options: { readonly timezone: string; readonly country: string; readonly now: Date },
): AgentConfig {
  const start =
    base ??
    defaultAgentConfig({
      locale: draft.defaultLocale,
      timezone: options.timezone,
      businessName: draft.businessName,
      now: options.now,
    });
  const locales = [
    draft.defaultLocale,
    ...start.languages
      .map((entry) => entry.locale)
      .filter((locale) => locale !== draft.defaultLocale),
  ].slice(0, 3);
  const languages = locales.map((locale) => {
    const existing = start.languages.find((entry) => entry.locale === locale);
    const defaults = languageDefaults(locale, draft.businessName);
    return {
      locale,
      greeting:
        locale === draft.defaultLocale && draft.greeting.trim() !== ''
          ? draft.greeting.trim().slice(0, 500)
          : suggestedGreeting(locale, draft.businessName, draft.persona, draft.addressing),
      fallback: existing?.fallback ?? defaults.fallback,
      closing: existing?.closing ?? defaults.closing,
    };
  });
  const texts: Partial<Record<AgentLocale, string>> = {};
  for (const locale of locales) {
    texts[locale] =
      start.disclosure.texts[locale] ?? languageDefaults(locale, draft.businessName).disclosure;
  }
  const disclosureChanged = locales.some(
    (locale) => start.disclosure.texts[locale] !== texts[locale],
  );
  const transfer = normalizePhone(draft.transferNumber, options.country);
  const destinations = [
    ...start.handoff.destinations.filter((destination) => destination.label !== HANDOFF_LABEL),
    ...(transfer === null
      ? []
      : [{ label: HANDOFF_LABEL, e164: transfer, description: draft.businessName.slice(0, 120) }]),
  ];
  const defaultLabel =
    transfer !== null
      ? HANDOFF_LABEL
      : start.handoff.default_destination_label === HANDOFF_LABEL
        ? undefined
        : start.handoff.default_destination_label;
  const persona = {
    ...STYLE_PERSONA[draft.style],
    formality: draft.addressing === 'formal' ? 80 : 30,
    pace: PACE_VALUE[draft.pace],
  };
  const booking = start.specialists.find((specialist) => specialist.kind === 'BOOKING');
  const fallbackBooking = defaultAgentConfig({
    locale: draft.defaultLocale,
    timezone: options.timezone,
    businessName: draft.businessName,
    now: options.now,
  }).specialists.find((specialist) => specialist.kind === 'BOOKING');
  const specialists = start.specialists.map((specialist) =>
    specialist.kind === 'BOOKING' ? { ...specialist, enabled: draft.bookings } : specialist,
  );
  if (booking === undefined && draft.bookings && fallbackBooking !== undefined) {
    specialists.push(fallbackBooking);
  }
  return {
    ...start,
    voice: VOICE_PERSONAS.find((entry) => entry.key === draft.persona)?.voice ?? start.voice,
    default_locale: draft.defaultLocale,
    persona,
    languages,
    disclosure: {
      version: disclosureChanged
        ? disclosureVersion(options.now, start.disclosure.version)
        : start.disclosure.version,
      texts,
    },
    specialists,
    handoff: {
      dtmf: start.handoff.dtmf,
      warm_transfer: start.handoff.warm_transfer,
      failed_understandings_before_offer: start.handoff.failed_understandings_before_offer,
      destinations,
      ...(defaultLabel === undefined ? {} : { default_destination_label: defaultLabel }),
      no_answer_behavior: draft.noAnswer,
    },
    limits: {
      ...start.limits,
      max_call_duration_seconds: Math.min(3600, Math.max(60, draft.maxCallMinutes * 60)),
    },
    timezone: options.timezone,
    business_hours: openHours(draft.hours),
    after_hours:
      draft.afterHours === 'TRANSFER_ON_CALL' && transfer !== null
        ? { behavior: 'TRANSFER_ON_CALL', on_call_destination_label: HANDOFF_LABEL }
        : {
            behavior: draft.afterHours === 'TRANSFER_ON_CALL' ? 'TAKE_MESSAGE' : draft.afterHours,
          },
    recording: { enabled: draft.recording },
  };
}

export interface SetupScenario {
  readonly scenario_key: string;
  readonly scenario_class: 'HAPPY_PATH';
  readonly language: AgentLocale;
  readonly definition: ScenarioDefinition;
  readonly deterministic_assertions: readonly ScenarioAssertion[];
}

const SCENARIO_TEXT: Readonly<
  Record<
    AgentLocale,
    Readonly<Record<'hours' | 'booking' | 'human', { goal: string; opening: string }>>
  >
> = {
  hu: {
    hours: {
      goal: 'Megtudni, hogy mikor van nyitva a vállalkozás.',
      opening: 'Jó napot! Szeretném megkérdezni, mikor vannak nyitva?',
    },
    booking: {
      goal: 'Időpontot foglalni holnap délutánra két főre, a saját nevén.',
      opening: 'Szeretnék foglalni holnap délutánra.',
    },
    human: {
      goal: 'Élő munkatárssal beszélni egy egyedi kérés miatt.',
      opening: 'Kérem, kapcsoljon egy munkatárshoz.',
    },
  },
  en: {
    hours: {
      goal: 'Find out when the business is open.',
      opening: 'Hi, could you tell me your opening hours?',
    },
    booking: {
      goal: 'Book a slot for two people tomorrow afternoon under their own name.',
      opening: "I'd like to make a booking for tomorrow afternoon.",
    },
    human: {
      goal: 'Speak to a human member of staff about a special request.',
      opening: 'Could you put me through to someone from the team, please?',
    },
  },
  de: {
    hours: {
      goal: 'Herausfinden, wann das Unternehmen geöffnet hat.',
      opening: 'Guten Tag, wann haben Sie geöffnet?',
    },
    booking: {
      goal: 'Für morgen Nachmittag für zwei Personen auf den eigenen Namen buchen.',
      opening: 'Ich möchte gerne für morgen Nachmittag buchen.',
    },
    human: {
      goal: 'Wegen eines besonderen Anliegens mit einer Mitarbeiterin sprechen.',
      opening: 'Können Sie mich bitte mit einem Mitarbeiter verbinden?',
    },
  },
};

const CALLER_NAMES: Readonly<Record<AgentLocale, string>> = {
  hu: 'Kovács Péter',
  en: 'Peter Smith',
  de: 'Peter Müller',
};

export function setupScenarios(draft: SetupDraft, country: string): SetupScenario[] {
  const locale = draft.defaultLocale;
  const text = SCENARIO_TEXT[locale];
  const scenarios: SetupScenario[] = [
    {
      scenario_key: 'setup.opening_hours',
      scenario_class: 'HAPPY_PATH',
      language: locale,
      definition: {
        caller_goal: text.hours.goal,
        opening_line: text.hours.opening,
        caller_facts: {},
        max_turns: 8,
      },
      deterministic_assertions: [],
    },
  ];
  if (draft.bookings) {
    scenarios.push({
      scenario_key: 'setup.booking',
      scenario_class: 'HAPPY_PATH',
      language: locale,
      definition: {
        caller_goal: text.booking.goal,
        opening_line: text.booking.opening,
        caller_facts: { name: CALLER_NAMES[locale], party_size: '2' },
        max_turns: 14,
      },
      deterministic_assertions: [{ type: 'TOOL_CALLED', tool: 'check_availability' }],
    });
  }
  if (normalizePhone(draft.transferNumber, country) !== null) {
    scenarios.push({
      scenario_key: 'setup.human_handoff',
      scenario_class: 'HAPPY_PATH',
      language: locale,
      definition: {
        caller_goal: text.human.goal,
        opening_line: text.human.opening,
        caller_facts: {},
        max_turns: 8,
      },
      deterministic_assertions: [{ type: 'TRANSFERRED' }],
    });
  }
  return scenarios;
}

export type Activation = 'ready' | 'payment' | 'provisioning';

const UNPAID_STATES: ReadonlySet<string> = new Set(['ORDER_CREATED', 'PAYMENT_PENDING']);
const AI_READY_STATES: ReadonlySet<string> = new Set([
  'OPENAI_READY',
  'PHONE_RESERVING',
  'PHONE_ORDERING',
  'PHONE_KYC_REQUIRED',
  'WAITING_FOR_CUSTOMER',
  'PHONE_UNDER_REVIEW',
  'WAITING_FOR_PROVIDER',
  'PHONE_READY',
  'SIP_AGENT_BINDING',
  'AGENT_READY',
  'TEST_CALL_READY',
  'GO_LIVE_ELIGIBLE',
  'ACTIVE',
]);

export function activationOf(
  workspaceStatus: string,
  provisioning: ProvisioningStatus | null,
): Activation {
  if (
    workspaceStatus === 'ACTIVE' ||
    provisioning?.steps.some(
      (entry) => entry.step === 'OPENAI_API_KEY' && entry.status === 'SUCCEEDED',
    ) === true ||
    (provisioning?.workflow !== null &&
      provisioning?.workflow !== undefined &&
      AI_READY_STATES.has(provisioning.workflow.state))
  ) {
    return 'ready';
  }
  if (
    provisioning === null ||
    provisioning.workflow === null ||
    UNPAID_STATES.has(provisioning.workflow.state)
  ) {
    return 'payment';
  }
  return 'provisioning';
}

export const CREDENTIAL_ERRORS: ReadonlySet<string> = new Set([
  'embedding_credentials_missing',
  'embedding_credentials_unavailable',
  'openai_credentials_missing',
]);
