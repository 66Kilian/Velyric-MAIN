import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  billingMarketForCountry,
  buildEntitlement,
  EntitlementError,
  overageChargeMinor,
  overageSeconds,
  validateAddOns,
} from '../src/entitlements.js';
import {
  graceSteps,
  nextTenantStatus,
  renewalReminderSteps,
  tenantAcceptsCalls,
  tenantRetainsConfiguration,
  TenantTransitionError,
} from '../src/tenant-lifecycle.js';

const period = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') };

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof EntitlementError ? error.reason : 'OTHER';
  }
}

describe('entitlements', () => {
  it('derives plan limits from the v6 catalog', () => {
    const start = buildEntitlement('START', 'HU', [], period);
    expect(start).toMatchObject({
      includedVoiceSeconds: 9000,
      overageMinorPerMinute: 14_900,
      concurrencyLimit: 2,
      currency: 'HUF',
    });
    expect(buildEntitlement('BUSINESS', 'HU', [], period)).toMatchObject({
      includedVoiceSeconds: 24_000,
      concurrencyLimit: 10,
    });
    const pro = buildEntitlement('PRO', 'HU', [], period);
    expect(pro).toMatchObject({
      includedVoiceSeconds: 60_000,
      overageMinorPerMinute: 10_900,
      concurrencyLimit: 50,
    });
    expect(pro.features).toContain('simulation_lab');
    expect(start.features).not.toContain('booking_engine');
  });

  it('applies add-ons and enforces availability and stacking', () => {
    const boosted = buildEntitlement(
      'BUSINESS',
      'HU',
      [
        { code: 'CONCURRENCY_BOOST', quantity: 2 },
        { code: 'EXTRA_PHONE_NUMBER', quantity: 3 },
      ],
      period,
    );
    expect(boosted.concurrencyLimit).toBeGreaterThan(10);
    expect(boosted.limits.phone_numbers).toBe(4);
    expect(
      reason(() => {
        validateAddOns('START', [{ code: 'EXTRA_LOCATION', quantity: 1 }]);
      }),
    ).toBe('ADD_ON_NOT_AVAILABLE');
    expect(
      reason(() => {
        validateAddOns('BUSINESS', [{ code: 'OUTBOUND_CALLING', quantity: 2 }]);
      }),
    ).toBe('ADD_ON_NOT_STACKABLE');
    expect(
      reason(() => {
        validateAddOns('BUSINESS', [{ code: 'EXTRA_PHONE_NUMBER', quantity: 0 }]);
      }),
    ).toBe('INVALID_QUANTITY');
    expect(
      reason(() => {
        validateAddOns('BUSINESS', [
          { code: 'EXTRA_PHONE_NUMBER', quantity: 1 },
          { code: 'EXTRA_PHONE_NUMBER', quantity: 1 },
        ]);
      }),
    ).toBe('INVALID_QUANTITY');
  });

  it('never converts currencies and refuses markets without a price book', () => {
    expect(reason(() => buildEntitlement('START', 'INTERNATIONAL', [], period))).toBe(
      'PRICE_BOOK_UNAVAILABLE',
    );
    expect(reason(() => buildEntitlement('ENTERPRISE', 'HU', [], period))).toBe(
      'PLAN_NOT_SELF_SERVE',
    );
    expect(
      buildEntitlement('ENTERPRISE', 'INTERNATIONAL', [], period, {
        includedVoiceSeconds: 600_000,
        concurrencyLimit: 150,
        currency: 'EUR',
        overageMinorPerMinute: 25,
      }),
    ).toMatchObject({
      currency: 'EUR',
      concurrencyLimit: 150,
    });
    expect(
      reason(() => buildEntitlement('START', 'HU', [], { start: period.end, end: period.start })),
    ).toBe('INVALID_PERIOD');
    expect(billingMarketForCountry('hu')).toBe('HU');
    expect(billingMarketForCountry('DE')).toBe('INTERNATIONAL');
  });

  it('bills overage from real seconds and never undercharges', () => {
    expect(overageSeconds(9000, 8999)).toBe(0);
    expect(overageSeconds(9000, 9061)).toBe(61);
    expect(overageChargeMinor(60, 14_900)).toBe(14_900);
    expect(overageChargeMinor(1, 14_900)).toBe(249);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (seconds, rate) => {
          const charge = overageChargeMinor(seconds, rate);
          expect(charge * 60).toBeGreaterThanOrEqual(seconds * rate);
          expect((charge - 1) * 60).toBeLessThan(seconds * rate === 0 ? 1 : seconds * rate);
        },
      ),
    );
    expect(() => overageSeconds(-1, 5)).toThrow(RangeError);
  });
});

describe('tenant lifecycle', () => {
  it('follows the dunning path without deleting configuration', () => {
    let status = nextTenantStatus('PROVISIONING', 'PROVISIONING_COMPLETED');
    expect(status).toBe('ACTIVE');
    status = nextTenantStatus(status, 'RENEWAL_PAYMENT_FAILED');
    expect(status).toBe('GRACE_PERIOD');
    expect(tenantAcceptsCalls(status)).toBe(true);
    status = nextTenantStatus(status, 'GRACE_EXPIRED');
    expect(status).toBe('SUSPENDED_BILLING');
    expect(tenantAcceptsCalls(status)).toBe(false);
    expect(tenantRetainsConfiguration(status)).toBe(true);
    expect(nextTenantStatus(status, 'INVOICE_PAID')).toBe('ACTIVE');
  });

  it('handles disputes, cancellation and deletion as separate audited steps', () => {
    expect(nextTenantStatus('ACTIVE', 'DISPUTE_OPENED')).toBe('SUSPENDED_DISPUTE');
    expect(nextTenantStatus('SUSPENDED_DISPUTE', 'DISPUTE_WON')).toBe('ACTIVE');
    expect(() => nextTenantStatus('SUSPENDED_DISPUTE', 'INVOICE_PAID')).toThrow(
      TenantTransitionError,
    );
    const canceled = nextTenantStatus('ACTIVE', 'SUBSCRIPTION_CANCELED');
    expect(canceled).toBe('CANCELED_GRACE');
    expect(nextTenantStatus(canceled, 'INVOICE_PAID')).toBe('ACTIVE');
    const retention = nextTenantStatus(canceled, 'CANCEL_GRACE_EXPIRED');
    const deletion = nextTenantStatus(retention, 'RETENTION_EXPIRED');
    expect(nextTenantStatus(deletion, 'DELETION_COMPLETED')).toBe('DELETED');
    expect(() => nextTenantStatus('DELETED', 'DISPUTE_OPENED')).toThrow(TenantTransitionError);
    expect(() => nextTenantStatus('ACTIVE', 'GRACE_EXPIRED')).toThrow(TenantTransitionError);
    expect(nextTenantStatus('ACTIVE', 'RISK_BLOCKED')).toBe('SUSPENDED_RISK');
    expect(nextTenantStatus('SUSPENDED_RISK', 'RISK_CLEARED')).toBe('ACTIVE');
    expect(nextTenantStatus('RESTRICTED', 'ADMIN_SUSPENDED')).toBe('SUSPENDED_ADMIN');
    expect(nextTenantStatus('SUSPENDED_ADMIN', 'ADMIN_RELEASED')).toBe('ACTIVE');
  });

  it('computes the -5/-3/-1 reminder and +1/+2 grace schedule with suspension after day 2', () => {
    const periodEnd = new Date('2026-11-01T00:00:00Z');
    expect(renewalReminderSteps(periodEnd).map((step) => step.at.toISOString())).toEqual([
      '2026-10-27T00:00:00.000Z',
      '2026-10-29T00:00:00.000Z',
      '2026-10-31T00:00:00.000Z',
    ]);
    const grace = graceSteps(periodEnd);
    expect(grace.reminder.at.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(grace.finalDay.at.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(grace.suspendAt.toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });
});
