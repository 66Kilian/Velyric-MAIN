import { simulatorPriceBook } from '@velyric/testkit';
import { describe, expect, it } from 'vitest';
import { SeedEnvironmentError, seedLocal } from '../src/seeds.js';
import { useMigratedDatabase } from './support/db.js';

const database = useMigratedDatabase();

describe('local seeds', () => {
  it('upserts the simulator price book idempotently and refuses deployed environments', async () => {
    const priceBook = simulatorPriceBook();
    expect(priceBook.length).toBeGreaterThanOrEqual(6);
    const first = await seedLocal({
      connectionString: database().connectionString,
      environment: 'ci',
      priceBook,
    });
    const second = await seedLocal({
      connectionString: database().connectionString,
      environment: 'local',
      priceBook,
    });
    expect(first).toEqual(second);
    const rows = await database().admin.query<{
      stripe_price_id: string;
      unit_amount_minor: string;
      item_kind: string;
      billing_interval: string;
    }>(
      `SELECT stripe_price_id, unit_amount_minor, item_kind, billing_interval FROM app.price_books WHERE stripe_price_id LIKE 'price_sim_%' ORDER BY stripe_price_id`,
    );
    expect(rows.rows).toHaveLength(priceBook.length);
    const start = rows.rows.find((row) => row.stripe_price_id.startsWith('price_sim_plan_start_'));
    expect(start).toMatchObject({
      item_kind: 'PLAN',
      billing_interval: 'MONTH',
      unit_amount_minor: '3990000',
    });
    await expect(
      seedLocal({
        connectionString: database().connectionString,
        environment: 'staging',
        priceBook,
      }),
    ).rejects.toBeInstanceOf(SeedEnvironmentError);
  });
});
