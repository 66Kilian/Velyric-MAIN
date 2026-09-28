import { FeatureKey } from './enums.js';
import type {
  AddOnBillingType,
  AddOnCode,
  BillingMarket,
  BurstPolicy,
  Currency,
  PlanCode,
} from './enums.js';

export const PRICING_VERSION = '2026-09-11.v6';

export const CURRENCY_MINOR_UNIT_EXPONENT: Readonly<Record<Currency, number>> = Object.freeze({
  HUF: 2,
  EUR: 2,
  USD: 2,
});

export const PROVIDER_COST_MICROS_PER_UNIT = 1_000_000;

export const DEFAULT_MAX_CALL_DURATION_SECONDS = 1_800;

export interface PlanPrice {
  readonly market: BillingMarket;
  readonly currency: Currency;
  readonly monthlyNetMinor: number;
  readonly overagePerMinuteNetMinor: number;
}

export interface PlanDefinition {
  readonly code: PlanCode;
  readonly contractDefined: boolean;
  readonly prices: readonly PlanPrice[];
  readonly includedVoiceSeconds: number | null;
  readonly concurrentCalls: number;
  readonly burstPolicy: BurstPolicy;
  readonly includedPhoneNumbers: number;
  readonly includedLocations: number;
  readonly maxAgents: number | null;
  readonly maxCallDurationSeconds: number;
  readonly features: readonly FeatureKey[];
}

const F = FeatureKey;

const START_FEATURES: readonly FeatureKey[] = Object.freeze([
  F.KNOWLEDGE_BASE,
  F.HUMAN_HANDOFF,
  F.DTMF_ROUTING,
  F.BUSINESS_HOURS_ROUTING,
  F.CALLER_MEMORY,
  F.TRANSACTIONAL_EMAIL,
  F.QUALITY_MONITORING,
  F.WEB_VOICE_TEST_CALL,
]);

const BUSINESS_FEATURES: readonly FeatureKey[] = Object.freeze([
  ...START_FEATURES,
  F.GOOGLE_CALENDAR,
  F.MICROSOFT_365,
  F.CUSTOM_SMTP,
  F.CUSTOM_API_TOOLS,
  F.OUTBOUND_WEBHOOKS,
  F.PUBLIC_API,
  F.BOOKING_ENGINE,
  F.WAITLIST,
  F.WARM_TRANSFER,
  F.KNOWLEDGE_INTELLIGENCE,
  F.WEB_VOICE_WIDGET,
  F.ROI_ANALYTICS,
]);

const PRO_FEATURES: readonly FeatureKey[] = Object.freeze([
  ...BUSINESS_FEATURES,
  F.MULTI_WORKFLOW,
  F.ADVANCED_CALL_ROUTING,
  F.MULTI_LOCATION,
  F.SIMULATION_LAB,
  F.PRIORITY_SUPPORT,
]);

const ENTERPRISE_FEATURES: readonly FeatureKey[] = Object.freeze([
  ...PRO_FEATURES,
  F.PREMIUM_REASONING,
  F.SSO_SCIM,
  F.SIEM_EXPORT,
  F.BYOK,
  F.PCI_PAYMENTS,
  F.DEDICATED_REDUNDANCY,
  F.CONTRACTUAL_SLA,
  F.WHITE_LABEL,
]);

function hufPrice(monthlyNetMinor: number, overagePerMinuteNetMinor: number): PlanPrice {
  return Object.freeze({
    market: 'HU',
    currency: 'HUF',
    monthlyNetMinor,
    overagePerMinuteNetMinor,
  });
}

function plan(definition: PlanDefinition): PlanDefinition {
  return Object.freeze({ ...definition, prices: Object.freeze([...definition.prices]) });
}

export const PLAN_CATALOG: Readonly<Record<PlanCode, PlanDefinition>> = Object.freeze({
  START: plan({
    code: 'START',
    contractDefined: false,
    prices: [hufPrice(3_990_000, 14_900)],
    includedVoiceSeconds: 150 * 60,
    concurrentCalls: 2,
    burstPolicy: 'NONE',
    includedPhoneNumbers: 1,
    includedLocations: 1,
    maxAgents: 1,
    maxCallDurationSeconds: DEFAULT_MAX_CALL_DURATION_SECONDS,
    features: START_FEATURES,
  }),
  BUSINESS: plan({
    code: 'BUSINESS',
    contractDefined: false,
    prices: [hufPrice(6_990_000, 12_900)],
    includedVoiceSeconds: 400 * 60,
    concurrentCalls: 10,
    burstPolicy: 'PAID_BURST',
    includedPhoneNumbers: 1,
    includedLocations: 1,
    maxAgents: 3,
    maxCallDurationSeconds: DEFAULT_MAX_CALL_DURATION_SECONDS,
    features: BUSINESS_FEATURES,
  }),
  PRO: plan({
    code: 'PRO',
    contractDefined: false,
    prices: [hufPrice(12_990_000, 10_900)],
    includedVoiceSeconds: 1_000 * 60,
    concurrentCalls: 50,
    burstPolicy: 'CONFIGURABLE',
    includedPhoneNumbers: 1,
    includedLocations: 1,
    maxAgents: 10,
    maxCallDurationSeconds: DEFAULT_MAX_CALL_DURATION_SECONDS,
    features: PRO_FEATURES,
  }),
  ENTERPRISE: plan({
    code: 'ENTERPRISE',
    contractDefined: true,
    prices: [],
    includedVoiceSeconds: null,
    concurrentCalls: 100,
    burstPolicy: 'CONTRACTUAL',
    includedPhoneNumbers: 1,
    includedLocations: 1,
    maxAgents: null,
    maxCallDurationSeconds: DEFAULT_MAX_CALL_DURATION_SECONDS,
    features: ENTERPRISE_FEATURES,
  }),
});

export interface AddOnDefinition {
  readonly code: AddOnCode;
  readonly billingType: AddOnBillingType;
  readonly availableFor: readonly PlanCode[];
  readonly grantsFeatures: readonly FeatureKey[];
  readonly stackable: boolean;
}

const ALL_PLANS: readonly PlanCode[] = Object.freeze(['START', 'BUSINESS', 'PRO', 'ENTERPRISE']);
const BUSINESS_AND_UP: readonly PlanCode[] = Object.freeze(['BUSINESS', 'PRO', 'ENTERPRISE']);
const PRO_AND_UP: readonly PlanCode[] = Object.freeze(['PRO', 'ENTERPRISE']);
const ENTERPRISE_ONLY: readonly PlanCode[] = Object.freeze(['ENTERPRISE']);

function addOn(
  code: AddOnCode,
  billingType: AddOnBillingType,
  availableFor: readonly PlanCode[],
  grantsFeatures: readonly FeatureKey[],
  stackable: boolean,
): AddOnDefinition {
  return Object.freeze({
    code,
    billingType,
    availableFor,
    grantsFeatures: Object.freeze([...grantsFeatures]),
    stackable,
  });
}

export const ADD_ON_CATALOG: Readonly<Record<AddOnCode, AddOnDefinition>> = Object.freeze({
  EXTRA_PHONE_NUMBER: addOn('EXTRA_PHONE_NUMBER', 'RECURRING_MONTHLY', ALL_PLANS, [], true),
  EXTRA_LOCATION: addOn('EXTRA_LOCATION', 'RECURRING_MONTHLY', PRO_AND_UP, [], true),
  OUTBOUND_CALLING: addOn(
    'OUTBOUND_CALLING',
    'RECURRING_MONTHLY',
    BUSINESS_AND_UP,
    [F.OUTBOUND_CALLING],
    false,
  ),
  PREMIUM_REASONING: addOn(
    'PREMIUM_REASONING',
    'USAGE_BASED',
    ['PRO'],
    [F.PREMIUM_REASONING],
    false,
  ),
  CUSTOM_INTEGRATION_SETUP: addOn('CUSTOM_INTEGRATION_SETUP', 'ONE_TIME', ALL_PLANS, [], true),
  PRIVATE_CONNECTOR: addOn('PRIVATE_CONNECTOR', 'RECURRING_MONTHLY', PRO_AND_UP, [], true),
  LARGE_KNOWLEDGE_STORAGE: addOn(
    'LARGE_KNOWLEDGE_STORAGE',
    'RECURRING_MONTHLY',
    ALL_PLANS,
    [],
    true,
  ),
  CALL_RECORDING: addOn(
    'CALL_RECORDING',
    'RECURRING_MONTHLY',
    ALL_PLANS,
    [F.CALL_RECORDING],
    false,
  ),
  EXTENDED_RETENTION: addOn('EXTENDED_RETENTION', 'RECURRING_MONTHLY', ALL_PLANS, [], false),
  PHONE_NUMBER_RETENTION: addOn('PHONE_NUMBER_RETENTION', 'RECURRING_MONTHLY', ALL_PLANS, [], true),
  DEDICATED_SLA_SUPPORT: addOn(
    'DEDICATED_SLA_SUPPORT',
    'RECURRING_MONTHLY',
    PRO_AND_UP,
    [F.CONTRACTUAL_SLA, F.PRIORITY_SUPPORT],
    false,
  ),
  WHITE_LABEL_DOMAIN: addOn(
    'WHITE_LABEL_DOMAIN',
    'RECURRING_MONTHLY',
    PRO_AND_UP,
    [F.WHITE_LABEL],
    false,
  ),
  SIMULATION_CREDITS: addOn(
    'SIMULATION_CREDITS',
    'USAGE_BASED',
    BUSINESS_AND_UP,
    [F.SIMULATION_LAB],
    true,
  ),
  PCI_PAYMENTS: addOn(
    'PCI_PAYMENTS',
    'RECURRING_MONTHLY',
    ENTERPRISE_ONLY,
    [F.PCI_PAYMENTS],
    false,
  ),
  SSO_SCIM: addOn('SSO_SCIM', 'RECURRING_MONTHLY', PRO_AND_UP, [F.SSO_SCIM], false),
  SIEM_EXPORT: addOn('SIEM_EXPORT', 'RECURRING_MONTHLY', ENTERPRISE_ONLY, [F.SIEM_EXPORT], false),
  BYOK: addOn('BYOK', 'RECURRING_MONTHLY', ENTERPRISE_ONLY, [F.BYOK], false),
  DEDICATED_REDUNDANCY: addOn(
    'DEDICATED_REDUNDANCY',
    'RECURRING_MONTHLY',
    ENTERPRISE_ONLY,
    [F.DEDICATED_REDUNDANCY],
    false,
  ),
  CONCURRENCY_BOOST: addOn('CONCURRENCY_BOOST', 'RECURRING_MONTHLY', BUSINESS_AND_UP, [], true),
});

export const CONCURRENCY_BOOST_CALLS_PER_UNIT = 5;

export function planPriceForMarket(
  definition: PlanDefinition,
  market: BillingMarket,
): PlanPrice | null {
  return definition.prices.find((price) => price.market === market) ?? null;
}

export function planIncludesFeature(definition: PlanDefinition, feature: FeatureKey): boolean {
  return definition.features.includes(feature);
}
