import type { AgentConfig } from '@velyric/contracts';

export function agentConfigFixture(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schema_version: 1,
    voice: 'alloy',
    default_locale: 'hu',
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
        locale: 'hu',
        greeting: 'Üdvözlöm, a Példa Kft. AI-asszisztense vagyok. Miben segíthetek?',
        fallback: 'Elnézést, ezt nem értettem pontosan. Megismételné, kérem?',
        closing: 'Köszönöm a hívást, további szép napot kívánok!',
      },
      {
        locale: 'en',
        greeting: "Hello, you are speaking with Example Ltd.'s AI assistant. How can I help?",
        fallback: "Sorry, I didn't catch that. Could you say it again?",
        closing: 'Thank you for calling. Have a great day!',
      },
    ],
    disclosure: {
      version: '2026-09-01.1',
      texts: {
        hu: 'Tájékoztatjuk, hogy mesterséges intelligencia alapú asszisztenssel beszél.',
        en: 'Please note that you are speaking with an AI assistant.',
      },
    },
    specialists: [
      {
        kind: 'RECEPTION_ROUTER',
        enabled: true,
        tool_allowlist: [],
        max_tool_executions: 2,
        model_tier: 'ROUTINE',
      },
      {
        kind: 'HANDOFF_COMPLIANCE',
        enabled: true,
        tool_allowlist: [],
        max_tool_executions: 0,
        model_tier: 'ROUTINE',
      },
    ],
    handoff: {
      destinations: [{ label: 'front-desk', e164: '+3612345678', description: 'Recepció' }],
      default_destination_label: 'front-desk',
      dtmf: [{ sequence: '###', action: 'HUMAN_TRANSFER' }],
      warm_transfer: true,
      failed_understandings_before_offer: 2,
      no_answer_behavior: 'RETURN_TO_AI',
    },
    limits: {
      max_call_duration_seconds: 1800,
      max_tool_executions_per_call: 10,
      max_spend_usd_micros_per_call: 2_000_000,
      silence_timeout_seconds: 12,
    },
    timezone: 'Europe/Budapest',
    business_hours: [
      { iso_weekday: 1, opens: '09:00', closes: '17:00' },
      { iso_weekday: 2, opens: '09:00', closes: '17:00' },
    ],
    after_hours: { behavior: 'TAKE_MESSAGE' },
    recording: { enabled: false },
    overload: { policy: 'CALLBACK_REQUEST', max_wait_seconds: 0 },
    pronunciation: [{ term: 'Velyric', spoken_as: 'Velirik', locale: 'hu' }],
    model_routing: { complex_escalation_enabled: true, premium_reasoning_enabled: false },
    ...overrides,
  };
}

export {
  startProviderSimulator,
  SimulatorEnvironmentError,
  type ProviderSimulator,
  type ProviderSimulatorOptions,
} from './simulator/server.js';
export {
  simulatorPriceBook,
  simulatorStripePrices,
  type SimulatorPriceBookRow,
} from './simulator/prices.js';
export {
  DEFAULT_CALENDAR_ACCOUNTS,
  DEFAULT_CREDENTIALS,
  DEFAULT_USERS,
  SIMULATOR_OPENAI_WEBHOOK_SECRET,
  SIMULATOR_STRIPE_WEBHOOK_SECRET,
  type StripePrice,
  type SyntheticUser,
} from './simulator/context.js';
export {
  stripeSignature,
  standardWebhookSignature,
  type WebhookDelivery,
} from './simulator/webhooks.js';
