import {
  ADD_ON_CATALOG,
  CONCURRENCY_BOOST_CALLS_PER_UNIT,
  PLAN_CATALOG,
  PRICING_VERSION,
  type AddOnCode,
  type BillingMarket,
  type BurstPolicy,
  type Currency,
  type FeatureKey,
  type PlanCode,
} from '@velyric/contracts';

export interface AddOnSelection {
  readonly code: AddOnCode;
  readonly quantity: number;
}

export interface EntitlementPeriod {
  readonly start: Date;
  readonly end: Date;
}

export interface EntitlementLimits {
  readonly concurrent_calls: number;
  readonly max_call_duration_seconds: number;
  readonly max_agents: number | null;
  readonly phone_numbers: number;
  readonly locations: number;
  readonly outbound_calls_enabled: boolean;
  readonly recording_enabled: boolean;
}

export interface EntitlementDraft {
  readonly planCode: PlanCode;
  readonly pricingVersion: string;
  readonly currency: Currency;
  readonly includedVoiceSeconds: number;
  readonly overageMinorPerMinute: number;
  readonly concurrencyLimit: number;
  readonly burstPolicy: BurstPolicy;
  readonly features: readonly FeatureKey[];
  readonly limits: EntitlementLimits;
  readonly period: EntitlementPeriod;
}

export class EntitlementError extends Error {
  readonly reason:
    | 'PLAN_NOT_SELF_SERVE'
    | 'PRICE_BOOK_UNAVAILABLE'
    | 'ADD_ON_NOT_AVAILABLE'
    | 'ADD_ON_NOT_STACKABLE'
    | 'INVALID_QUANTITY'
    | 'INVALID_PERIOD';

  constructor(reason: EntitlementError['reason'], message: string) {
    super(message);
    this.name = 'EntitlementError';
    this.reason = reason;
  }
}

export function billingMarketForCountry(country: string): BillingMarket {
  return country.toUpperCase() === 'HU' ? 'HU' : 'INTERNATIONAL';
}

export function validateAddOns(planCode: PlanCode, addOns: readonly AddOnSelection[]): void {
  const seen = new Set<AddOnCode>();
  for (const selection of addOns) {
    const definition = ADD_ON_CATALOG[selection.code];
    if (
      !Number.isInteger(selection.quantity) ||
      selection.quantity < 1 ||
      selection.quantity > 100
    ) {
      throw new EntitlementError('INVALID_QUANTITY', `${selection.code} quantity must be 1-100`);
    }
    if (!definition.availableFor.includes(planCode)) {
      throw new EntitlementError(
        'ADD_ON_NOT_AVAILABLE',
        `${selection.code} is not available for ${planCode}`,
      );
    }
    if (seen.has(selection.code)) {
      throw new EntitlementError('INVALID_QUANTITY', `${selection.code} is listed more than once`);
    }
    if (!definition.stackable && selection.quantity > 1) {
      throw new EntitlementError(
        'ADD_ON_NOT_STACKABLE',
        `${selection.code} cannot be purchased more than once`,
      );
    }
    seen.add(selection.code);
  }
}

export function buildEntitlement(
  planCode: PlanCode,
  market: BillingMarket,
  addOns: readonly AddOnSelection[],
  period: EntitlementPeriod,
  contractOverrides?: {
    readonly includedVoiceSeconds: number;
    readonly concurrencyLimit: number;
    readonly currency: Currency;
    readonly overageMinorPerMinute: number;
  },
): EntitlementDraft {
  if (period.end.getTime() <= period.start.getTime()) {
    throw new EntitlementError('INVALID_PERIOD', 'entitlement period must end after it starts');
  }
  const plan = PLAN_CATALOG[planCode];
  validateAddOns(planCode, addOns);
  const price = plan.prices.find((candidate) => candidate.market === market);
  if (plan.contractDefined && contractOverrides === undefined) {
    throw new EntitlementError('PLAN_NOT_SELF_SERVE', `${planCode} requires contract terms`);
  }
  if (!plan.contractDefined && price === undefined) {
    throw new EntitlementError(
      'PRICE_BOOK_UNAVAILABLE',
      `${planCode} has no price for market ${market}`,
    );
  }
  const quantity = (code: AddOnCode): number =>
    addOns.find((selection) => selection.code === code)?.quantity ?? 0;
  const features = new Set<FeatureKey>(plan.features);
  for (const selection of addOns) {
    for (const feature of ADD_ON_CATALOG[selection.code].grantsFeatures) {
      features.add(feature);
    }
  }
  const baseConcurrency = contractOverrides?.concurrencyLimit ?? plan.concurrentCalls;
  const concurrencyLimit =
    baseConcurrency + quantity('CONCURRENCY_BOOST') * CONCURRENCY_BOOST_CALLS_PER_UNIT;
  return {
    planCode,
    pricingVersion: PRICING_VERSION,
    currency: contractOverrides?.currency ?? price?.currency ?? 'HUF',
    includedVoiceSeconds: contractOverrides?.includedVoiceSeconds ?? plan.includedVoiceSeconds ?? 0,
    overageMinorPerMinute:
      contractOverrides?.overageMinorPerMinute ?? price?.overagePerMinuteNetMinor ?? 0,
    concurrencyLimit,
    burstPolicy: plan.burstPolicy,
    features: [...features].sort(),
    limits: {
      concurrent_calls: concurrencyLimit,
      max_call_duration_seconds: plan.maxCallDurationSeconds,
      max_agents: plan.maxAgents,
      phone_numbers: plan.includedPhoneNumbers + quantity('EXTRA_PHONE_NUMBER'),
      locations: plan.includedLocations + quantity('EXTRA_LOCATION'),
      outbound_calls_enabled: features.has('outbound_calling'),
      recording_enabled: features.has('call_recording'),
    },
    period,
  };
}

export function overageSeconds(includedVoiceSeconds: number, consumedSeconds: number): number {
  if (
    !Number.isInteger(includedVoiceSeconds) ||
    !Number.isInteger(consumedSeconds) ||
    includedVoiceSeconds < 0 ||
    consumedSeconds < 0
  ) {
    throw new RangeError('seconds must be non-negative integers');
  }
  return Math.max(0, consumedSeconds - includedVoiceSeconds);
}

export function overageChargeMinor(
  overageSecondsUsed: number,
  overageMinorPerMinute: number,
): number {
  if (
    !Number.isInteger(overageSecondsUsed) ||
    overageSecondsUsed < 0 ||
    !Number.isInteger(overageMinorPerMinute) ||
    overageMinorPerMinute < 0
  ) {
    throw new RangeError('overage inputs must be non-negative integers');
  }
  return Math.ceil((overageSecondsUsed * overageMinorPerMinute) / 60);
}
