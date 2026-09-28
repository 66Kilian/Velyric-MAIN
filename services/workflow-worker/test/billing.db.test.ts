import { randomUUID } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import { issueInvoice } from '../src/activities/billing.js';
import { ProviderCallError } from '../src/providers/errors.js';
import type { PaidInvoice } from '../src/providers/stripe.js';
import { seedBillingProfile, seedTenant, testDependencies, useTestDatabase } from './support/db.js';

const database = useTestDatabase();
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const NOW = new Date('2026-09-14T08:00:00Z');

function paidInvoice(id: string, overrides: Partial<PaidInvoice> = {}): PaidInvoice {
  return {
    id,
    number: `STR-${id.slice(-6)}`,
    status: 'paid',
    currency: 'HUF',
    totalMinor: 3_810_000,
    totalExcludingTaxMinor: 3_000_000,
    paidAt: new Date('2026-09-13T22:30:00Z'),
    periodStart: new Date('2026-09-13T22:30:00Z'),
    periodEnd: new Date('2026-10-13T22:30:00Z'),
    subscriptionId: 'sub_test',
    lines: [
      { description: 'Velyric Starter', amountMinor: 3_000_000, quantity: 1 },
      { description: 'Discount placeholder line', amountMinor: 0, quantity: 1 },
    ],
    ...overrides,
  };
}

async function documents(tenantId: string): Promise<
  {
    status: string;
    invoice_number: string | null;
    attempt: number;
    last_error_code: string | null;
  }[]
> {
  const result = await database().admin.query<{
    status: string;
    invoice_number: string | null;
    attempt: number;
    last_error_code: string | null;
  }>(
    'SELECT status, invoice_number, attempt, last_error_code FROM app.billing_documents WHERE tenant_id = $1',
    [tenantId],
  );
  return result.rows;
}

describe('invoice issuance activity', () => {
  it('creates the Billingo partner and invoice once, emails it and records the outbox event', async () => {
    const tenantId = await seedTenant(database().admin);
    await seedBillingProfile(database().admin, tenantId);
    const { deps, providers } = testDependencies(database(), NOW);
    const invoiceId = `in_${randomUUID().replaceAll('-', '')}`;
    providers.billing.invoices.set(invoiceId, paidInvoice(invoiceId));

    const first = await issueInvoice(deps, {
      tenantId,
      stripeInvoiceId: invoiceId,
      orderId: null,
      traceId: TRACE,
    });
    expect(first).toMatchObject({
      status: 'SENT',
      invoiceNumber: expect.stringMatching(/^VLY-2026-\d{5}$/) as string,
    });
    expect(providers.billingo.partners).toHaveLength(1);
    expect(providers.billingo.partners[0]).toMatchObject({
      taxType: 'HAS_TAX_NUMBER',
      taxCode: '12345678-2-41',
      countryCode: 'HU',
    });
    expect(providers.billingo.invoices[0]).toMatchObject({
      blockId: 42,
      currency: 'HUF',
      language: 'hu',
      fulfillmentDate: '2026-09-14',
    });
    expect(providers.billingo.invoices[0]?.items).toEqual([
      { name: 'Velyric Starter', netUnitPrice: 30_000, quantity: 1, unit: 'db', vat: '27%' },
    ]);
    expect(providers.billingo.sent).toEqual([
      { documentId: expect.any(Number) as number, emails: ['szamla@demo-rendelo.hu'] },
    ]);

    const replay = await issueInvoice(deps, {
      tenantId,
      stripeInvoiceId: invoiceId,
      orderId: null,
      traceId: TRACE,
    });
    expect(replay).toMatchObject({
      status: 'ALREADY_ISSUED',
      billingDocumentId: first.billingDocumentId,
    });
    expect(providers.billingo.invoices).toHaveLength(1);
    expect(await documents(tenantId)).toEqual([
      { status: 'SENT', invoice_number: first.invoiceNumber, attempt: 1, last_error_code: null },
    ]);
    const outbox = await database().admin.query<{ event_type: string }>(
      'SELECT event_type FROM app.outbox_events WHERE tenant_id = $1',
      [tenantId],
    );
    expect(outbox.rows.map((row) => row.event_type)).toContain('billing.document_created');
  });

  it('refuses to retry a Billingo call whose outcome is unknown', async () => {
    const tenantId = await seedTenant(database().admin);
    await seedBillingProfile(database().admin, tenantId, { partnerId: 777 });
    const { deps, providers } = testDependencies(database(), NOW);
    const invoiceId = `in_${randomUUID().replaceAll('-', '')}`;
    providers.billing.invoices.set(invoiceId, paidInvoice(invoiceId));
    providers.billingo.createInvoiceFailure = new ProviderCallError(
      'billingo',
      'network_error',
      'create invoice failed',
      { retryable: true, outcomeUnknown: true },
    );

    const failure = await issueInvoice(deps, {
      tenantId,
      stripeInvoiceId: invoiceId,
      orderId: null,
      traceId: TRACE,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).nonRetryable).toBe(true);
    expect(providers.billingo.partners).toHaveLength(0);

    providers.billingo.createInvoiceFailure = null;
    const again = await issueInvoice(deps, {
      tenantId,
      stripeInvoiceId: invoiceId,
      orderId: null,
      traceId: TRACE,
    }).catch((error: unknown) => error);
    expect((again as ApplicationFailure).details).toEqual([
      { code: 'billing_document_outcome_unknown' },
    ]);
    expect(providers.billingo.invoices).toHaveLength(0);
    expect(await documents(tenantId)).toEqual([
      { status: 'PENDING', invoice_number: null, attempt: 1, last_error_code: 'OUTCOME_UNKNOWN' },
    ]);
  });

  it('retries a definitely failed request and marks undeliverable invoices for follow-up', async () => {
    const tenantId = await seedTenant(database().admin, { locale: 'en' });
    await seedBillingProfile(database().admin, tenantId, { partnerId: 778 });
    const { deps, providers } = testDependencies(database(), NOW);
    const invoiceId = `in_${randomUUID().replaceAll('-', '')}`;
    providers.billing.invoices.set(invoiceId, paidInvoice(invoiceId));
    providers.billingo.createInvoiceFailure = new ProviderCallError(
      'billingo',
      'rate_limited',
      'slow down',
      { retryable: true, httpStatus: 429 },
    );
    const throttled = await issueInvoice(deps, {
      tenantId,
      stripeInvoiceId: invoiceId,
      orderId: null,
      traceId: TRACE,
    }).catch((error: unknown) => error);
    expect(throttled).toBeInstanceOf(ApplicationFailure);
    expect((throttled as ApplicationFailure).nonRetryable).toBe(false);

    providers.billingo.createInvoiceFailure = null;
    providers.billingo.sendFailure = new ProviderCallError(
      'billingo',
      'invalid_email',
      'rejected',
      { retryable: false, httpStatus: 422 },
    );
    const result = await issueInvoice(deps, {
      tenantId,
      stripeInvoiceId: invoiceId,
      orderId: null,
      traceId: TRACE,
    });
    expect(result.status).toBe('SEND_FAILED');
    expect(providers.billingo.invoices[0]?.language).toBe('en');
    expect(await documents(tenantId)).toEqual([
      {
        status: 'SEND_FAILED',
        invoice_number: result.invoiceNumber,
        attempt: 2,
        last_error_code: 'invalid_email',
      },
    ]);
    expect(providers.email.messages).toHaveLength(1);
    expect(providers.email.messages[0]?.to).toBe('szamla@demo-rendelo.hu');
  });

  it('never issues unpaid or zero value invoices', async () => {
    const tenantId = await seedTenant(database().admin);
    await seedBillingProfile(database().admin, tenantId);
    const { deps, providers } = testDependencies(database(), NOW);
    providers.billing.invoices.set('in_open', paidInvoice('in_open', { status: 'open' }));
    providers.billing.invoices.set('in_zero', paidInvoice('in_zero', { totalMinor: 0 }));
    for (const stripeInvoiceId of ['in_open', 'in_zero']) {
      const failure = await issueInvoice(deps, {
        tenantId,
        stripeInvoiceId,
        orderId: null,
        traceId: TRACE,
      }).catch((error: unknown) => error);
      expect((failure as ApplicationFailure).nonRetryable).toBe(true);
    }
    expect(providers.billingo.invoices).toHaveLength(0);
    expect(await documents(tenantId)).toEqual([]);
  });
});
