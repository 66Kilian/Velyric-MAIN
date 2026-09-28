import pg from 'pg';

export interface PriceBookSeedRow {
  readonly pricingVersion: string;
  readonly market: string;
  readonly currency: string;
  readonly itemKind: 'PLAN' | 'OVERAGE' | 'ADD_ON';
  readonly planCode: string | null;
  readonly addOnCode?: string | null;
  readonly billingInterval: 'MONTH' | 'YEAR' | 'ONE_TIME' | 'METERED';
  readonly unitAmountMinor: number;
  readonly stripePriceId: string;
}

export interface LocalSeedOptions {
  readonly connectionString: string;
  readonly environment: string;
  readonly priceBook: readonly PriceBookSeedRow[];
}

export interface LocalSeedResult {
  readonly priceBookRows: number;
}

export class SeedEnvironmentError extends Error {
  constructor(environment: string) {
    super(
      `local seeds may only be applied when VELYRIC_ENV is local or ci (got ${environment || 'unset'})`,
    );
    this.name = 'SeedEnvironmentError';
  }
}

export async function seedLocal(options: LocalSeedOptions): Promise<LocalSeedResult> {
  if (options.environment !== 'local' && options.environment !== 'ci') {
    throw new SeedEnvironmentError(options.environment);
  }
  const client = new pg.Client({
    connectionString: options.connectionString,
    application_name: 'velyric-seed',
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const row of options.priceBook) {
      await client.query(
        `INSERT INTO app.price_books (pricing_version, market, currency, item_kind, plan_code, add_on_code, billing_interval, unit_amount_minor, stripe_price_id, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
         ON CONFLICT (pricing_version, market, currency, item_kind, plan_code, add_on_code, billing_interval)
         DO UPDATE SET unit_amount_minor = EXCLUDED.unit_amount_minor, stripe_price_id = EXCLUDED.stripe_price_id, active = true`,
        [
          row.pricingVersion,
          row.market,
          row.currency,
          row.itemKind,
          row.planCode,
          row.addOnCode ?? null,
          row.billingInterval,
          row.unitAmountMinor,
          row.stripePriceId,
        ],
      );
    }
    await client.query('COMMIT');
    return { priceBookRows: options.priceBook.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
