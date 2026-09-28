import { PLAN_CATALOG, PRICING_VERSION, type PlanCode } from '@velyric/contracts';
import type { StripePrice } from './context.js';

export interface SimulatorPriceBookRow {
  readonly pricingVersion: string;
  readonly market: string;
  readonly currency: string;
  readonly itemKind: 'PLAN' | 'OVERAGE';
  readonly planCode: PlanCode;
  readonly billingInterval: 'MONTH' | 'METERED';
  readonly unitAmountMinor: number;
  readonly stripePriceId: string;
}

export function simulatorPriceBook(): readonly SimulatorPriceBookRow[] {
  return Object.values(PLAN_CATALOG).flatMap((plan) =>
    plan.prices.flatMap((price) => {
      const suffix = `${plan.code.toLowerCase()}_${price.market.toLowerCase()}_${PRICING_VERSION.replaceAll(/[^0-9a-z]/gi, '')}`;
      return [
        {
          pricingVersion: PRICING_VERSION,
          market: price.market,
          currency: price.currency,
          itemKind: 'PLAN' as const,
          planCode: plan.code,
          billingInterval: 'MONTH' as const,
          unitAmountMinor: price.monthlyNetMinor,
          stripePriceId: `price_sim_plan_${suffix}`,
        },
        {
          pricingVersion: PRICING_VERSION,
          market: price.market,
          currency: price.currency,
          itemKind: 'OVERAGE' as const,
          planCode: plan.code,
          billingInterval: 'METERED' as const,
          unitAmountMinor: price.overagePerMinuteNetMinor,
          stripePriceId: `price_sim_overage_${suffix}`,
        },
      ];
    }),
  );
}

export function simulatorStripePrices(): readonly StripePrice[] {
  return simulatorPriceBook().map((row) => ({
    id: row.stripePriceId,
    unitAmount: row.unitAmountMinor,
    currency: row.currency.toLowerCase(),
    usageType: row.billingInterval === 'METERED' ? 'metered' : 'licensed',
  }));
}
