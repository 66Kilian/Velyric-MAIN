import type { AgentConfig, AgentLocale } from '@velyric/contracts';

const LANGUAGE_DEFAULTS: Readonly<
  Record<
    AgentLocale,
    {
      readonly greeting: string;
      readonly fallback: string;
      readonly closing: string;
      readonly disclosure: string;
    }
  >
> = {
  hu: {
    greeting: 'Jó napot kívánok, {business} vagyok, miben segíthetek?',
    fallback: 'Elnézést, ezt nem értettem pontosan. Megismételné, kérem?',
    closing: 'Köszönöm a hívást, további szép napot kívánok!',
    disclosure: 'Tájékoztatjuk, hogy mesterséges intelligencia alapú asszisztenssel beszél.',
  },
  de: {
    greeting: 'Guten Tag, hier ist {business}. Wie kann ich Ihnen helfen?',
    fallback:
      'Entschuldigung, das habe ich nicht genau verstanden. Könnten Sie das bitte wiederholen?',
    closing: 'Vielen Dank für Ihren Anruf und einen schönen Tag noch!',
    disclosure: 'Bitte beachten Sie, dass Sie mit einem KI-gestützten Assistenten sprechen.',
  },
  en: {
    greeting: 'Hello, you have reached {business}. How can I help you today?',
    fallback: "Sorry, I didn't quite catch that. Could you say it again?",
    closing: 'Thank you for calling. Have a great day!',
    disclosure: 'Please note that you are speaking with an AI assistant.',
  },
};

export function languageDefaults(
  locale: AgentLocale,
  businessName: string,
): {
  readonly greeting: string;
  readonly fallback: string;
  readonly closing: string;
  readonly disclosure: string;
} {
  const defaults = LANGUAGE_DEFAULTS[locale];
  return { ...defaults, greeting: defaults.greeting.replace('{business}', businessName) };
}

export function disclosureVersion(now: Date, previous?: string): string {
  const day = now.toISOString().slice(0, 10);
  if (previous !== undefined && previous.startsWith(`${day}.`)) {
    const counter = Number(previous.slice(11));
    return `${day}.${String(Number.isFinite(counter) ? Math.min(999, counter + 1) : 1)}`;
  }
  return `${day}.1`;
}

export function defaultAgentConfig(options: {
  readonly locale: AgentLocale;
  readonly timezone: string;
  readonly businessName: string;
  readonly now: Date;
}): AgentConfig {
  const language = languageDefaults(options.locale, options.businessName);
  return {
    schema_version: 1,
    voice: 'marin',
    default_locale: options.locale,
    persona: {
      warmth: 70,
      formality: 60,
      energy: 50,
      pace: 50,
      brevity: 60,
      empathy: 70,
      humor: 10,
      assertiveness: 40,
    },
    languages: [
      {
        locale: options.locale,
        greeting: language.greeting,
        fallback: language.fallback,
        closing: language.closing,
      },
    ],
    disclosure: {
      version: disclosureVersion(options.now),
      texts: { [options.locale]: language.disclosure },
    },
    specialists: [
      {
        kind: 'RECEPTION_ROUTER',
        enabled: true,
        tool_allowlist: ['search_knowledge', 'list_services'],
        max_tool_executions: 4,
        model_tier: 'ROUTINE',
      },
      {
        kind: 'BOOKING',
        enabled: true,
        tool_allowlist: [
          'list_services',
          'check_availability',
          'create_booking',
          'find_booking',
          'cancel_booking',
          'reschedule_booking',
        ],
        max_tool_executions: 8,
        model_tier: 'ROUTINE',
      },
    ],
    handoff: {
      destinations: [],
      dtmf: [],
      warm_transfer: true,
      failed_understandings_before_offer: 2,
      no_answer_behavior: 'CALLBACK_REQUEST',
    },
    limits: {
      max_call_duration_seconds: 900,
      max_tool_executions_per_call: 12,
      max_spend_usd_micros_per_call: 2_000_000,
      silence_timeout_seconds: 15,
    },
    timezone: options.timezone,
    business_hours: [1, 2, 3, 4, 5].map((day) => ({
      iso_weekday: day,
      opens: '08:00',
      closes: '17:00',
    })),
    after_hours: { behavior: 'TAKE_MESSAGE' },
    recording: { enabled: false },
    overload: { policy: 'CALLBACK_REQUEST', max_wait_seconds: 0 },
    pronunciation: [],
    model_routing: { complex_escalation_enabled: false, premium_reasoning_enabled: false },
  };
}
