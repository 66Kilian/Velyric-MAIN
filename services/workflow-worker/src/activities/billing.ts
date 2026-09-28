import { PLAN_CATALOG, type PlanCode } from '@velyric/contracts';
import { graceSteps, renewalReminderSteps } from '@velyric/domain';
import { billingoTaxTreatment, type BillingoLanguage } from '../providers/billingo.js';
import { ProviderCallError } from '../providers/errors.js';
import type {
  BillingActivities,
  DunningInput,
  GraceSchedule,
  InvoiceIssuanceInput,
  InvoiceIssuanceResult,
  RenewalRemindersInput,
  RenewalSchedule,
} from '../workflows/types.js';
import { createNotificationActivity } from './notifications.js';
import {
  applyTenantTransition,
  formatDate,
  formatDateTime,
  formatMinor,
  inTenant,
  newId,
  nonRetryable,
  providerFailure,
  type ActivityDependencies,
} from './support.js';

const OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN';

function budapestDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return parts;
}

export async function issueInvoice(
  deps: ActivityDependencies,
  input: InvoiceIssuanceInput,
): Promise<InvoiceIssuanceResult> {
  const idempotencyKey = `stripe_invoice:${input.stripeInvoiceId}`;
  const existing = await inTenant(deps, input.tenantId, input.traceId, (trx) =>
    trx
      .selectFrom('billing_documents')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst(),
  );
  if (
    existing !== undefined &&
    (existing.status === 'SENT' ||
      existing.status === 'CREATED' ||
      existing.status === 'SEND_FAILED')
  ) {
    if (existing.status === 'CREATED' && existing.billingo_document_id !== null) {
      return sendDocument(
        deps,
        input,
        existing.id,
        Number(existing.billingo_document_id),
        existing.invoice_number,
      );
    }
    return {
      status: 'ALREADY_ISSUED',
      billingDocumentId: existing.id,
      invoiceNumber: existing.invoice_number,
    };
  }
  if (existing?.last_error_code === OUTCOME_UNKNOWN) {
    throw nonRetryable(
      'billing_document_outcome_unknown',
      'a previous Billingo request may have created this invoice; manual reconciliation is required',
    );
  }

  let invoice;
  try {
    invoice = await deps.billing.retrieveInvoice(input.stripeInvoiceId);
  } catch (error) {
    return providerFailure(error);
  }
  if (invoice.status !== 'paid') {
    throw nonRetryable('stripe_invoice_not_paid', `Stripe invoice is ${invoice.status}`);
  }
  if (invoice.totalMinor <= 0) {
    throw nonRetryable(
      'stripe_invoice_zero_total',
      'zero value invoices are not issued in Billingo',
    );
  }

  const context = await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
    const profile = await trx
      .selectFrom('billing_profiles')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const tenant = await trx
      .selectFrom('tenants')
      .select(['default_locale'])
      .where('id', '=', input.tenantId)
      .executeTakeFirstOrThrow();
    return { profile, locale: tenant.default_locale };
  });
  if (context.profile === undefined) {
    throw nonRetryable('billing_profile_missing', 'the tenant has no billing profile');
  }
  const profile = context.profile;
  const tax = billingoTaxTreatment({
    customerType: profile.customer_type === 'INDIVIDUAL' ? 'INDIVIDUAL' : 'BUSINESS',
    country: profile.country,
    huTaxNumber: profile.hu_tax_number,
    euVatId: profile.eu_vat_id,
  });

  let partnerId = profile.billingo_partner_id === null ? null : Number(profile.billingo_partner_id);
  if (partnerId === null) {
    try {
      partnerId = await deps.billingo.createPartner({
        name: profile.legal_name,
        countryCode: profile.country,
        postCode: profile.postal_code,
        city: profile.city,
        address: [profile.address_line1, profile.address_line2]
          .filter((line): line is string => line !== null && line !== '')
          .join(', '),
        emails: [profile.billing_email],
        taxCode: tax.taxCode,
        taxType: tax.taxType,
      });
    } catch (error) {
      return providerFailure(error);
    }
    const createdPartnerId = partnerId;
    await inTenant(deps, input.tenantId, input.traceId, (trx) =>
      trx
        .updateTable('billing_profiles')
        .set((eb) => ({
          billingo_partner_id: String(createdPartnerId),
          version: eb('version', '+', 1),
        }))
        .where('id', '=', profile.id)
        .execute(),
    );
  }

  const lineItems = invoice.lines
    .filter((line) => line.amountMinor !== 0)
    .map((line) => ({
      description: line.description,
      amount_minor: line.amountMinor,
      quantity: Math.max(1, line.quantity),
    }));
  const documentId = await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
    const row = await trx
      .insertInto('billing_documents')
      .values({
        id: existing?.id ?? newId(),
        tenant_id: input.tenantId,
        order_id: input.orderId,
        billing_profile_id: profile.id,
        stripe_invoice_id: input.stripeInvoiceId,
        document_type: 'INVOICE',
        status: 'PENDING',
        billingo_partner_id: String(partnerId),
        total_minor: String(invoice.totalMinor),
        currency: invoice.currency,
        line_items: JSON.stringify(lineItems),
        idempotency_key: idempotencyKey,
        attempt: 1,
        last_error_code: OUTCOME_UNKNOWN,
      })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'idempotency_key']).doUpdateSet((eb) => ({
          attempt: eb('billing_documents.attempt', '+', 1),
          last_error_code: OUTCOME_UNKNOWN,
          billingo_partner_id: String(partnerId),
          updated_at: new Date(),
        })),
      )
      .returning(['id'])
      .executeTakeFirstOrThrow();
    return row.id;
  });

  let created;
  try {
    created = await deps.billingo.createInvoice({
      partnerId,
      blockId: deps.settings.billingoBlockId,
      fulfillmentDate: budapestDate(invoice.paidAt ?? deps.now()),
      dueDate: budapestDate(invoice.paidAt ?? deps.now()),
      language: (['hu', 'de', 'en'].includes(context.locale)
        ? context.locale
        : 'hu') as BillingoLanguage,
      currency: invoice.currency,
      items: lineItems.map((line) => ({
        name: line.description.slice(0, 250),
        netUnitPrice: Math.round(line.amount_minor / line.quantity) / 100,
        quantity: line.quantity,
        unit: 'db',
        vat: tax.vat,
      })),
      comment: `Stripe ${invoice.number ?? invoice.id}`,
      orderNumber: invoice.number ?? invoice.id,
    });
  } catch (error) {
    const outcomeUnknown = error instanceof ProviderCallError && error.outcomeUnknown;
    await inTenant(deps, input.tenantId, input.traceId, (trx) =>
      trx
        .updateTable('billing_documents')
        .set({
          last_error_code: outcomeUnknown
            ? OUTCOME_UNKNOWN
            : error instanceof ProviderCallError
              ? error.code.slice(0, 100)
              : 'billingo_failure',
          status:
            error instanceof ProviderCallError && !error.retryable && !outcomeUnknown
              ? 'FAILED'
              : 'PENDING',
          updated_at: new Date(),
        })
        .where('id', '=', documentId)
        .execute(),
    );
    return providerFailure(error);
  }
  await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
    await trx
      .updateTable('billing_documents')
      .set((eb) => ({
        status: 'CREATED',
        billingo_document_id: String(created.id),
        invoice_number: created.invoiceNumber,
        issued_at: deps.now(),
        last_error_code: null,
        version: eb('version', '+', 1),
      }))
      .where('id', '=', documentId)
      .execute();
    await trx
      .insertInto('outbox_events')
      .values({
        id: newId(),
        tenant_id: input.tenantId,
        event_id: newId(),
        event_type: 'billing.document_created',
        schema_version: 1,
        subject: `domain.v1.${input.tenantId}.billing.document_created`,
        payload: JSON.stringify({
          tenant_id: input.tenantId,
          billing_document_id: documentId,
          stripe_invoice_id: input.stripeInvoiceId,
          invoice_number: created.invoiceNumber,
        }),
        trace_id: input.traceId,
        occurred_at: deps.now(),
      })
      .execute();
  });
  return sendDocument(deps, input, documentId, created.id, created.invoiceNumber);
}

async function sendDocument(
  deps: ActivityDependencies,
  input: InvoiceIssuanceInput,
  documentId: string,
  billingoDocumentId: number,
  invoiceNumber: string | null,
): Promise<InvoiceIssuanceResult> {
  const profile = await inTenant(deps, input.tenantId, input.traceId, (trx) =>
    trx
      .selectFrom('billing_profiles')
      .select(['billing_email'])
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow(),
  );
  try {
    await deps.billingo.sendInvoice(billingoDocumentId, [profile.billing_email]);
  } catch (error) {
    if (error instanceof ProviderCallError && error.retryable) {
      throw error;
    }
    await inTenant(deps, input.tenantId, input.traceId, (trx) =>
      trx
        .updateTable('billing_documents')
        .set((eb) => ({
          status: 'SEND_FAILED',
          last_error_code:
            error instanceof ProviderCallError ? error.code.slice(0, 100) : 'send_failed',
          version: eb('version', '+', 1),
        }))
        .where('id', '=', documentId)
        .execute(),
    );
    await createNotificationActivity(deps)({
      tenantId: input.tenantId,
      type: 'INVOICE_DELIVERY_FAILED',
      dedupeKey: `invoice_delivery_failed:${input.stripeInvoiceId}`,
      payload: {
        invoice_number: invoiceNumber ?? input.stripeInvoiceId,
        billing_email: profile.billing_email,
      },
      traceId: input.traceId,
    });
    return { status: 'SEND_FAILED', billingDocumentId: documentId, invoiceNumber };
  }
  await inTenant(deps, input.tenantId, input.traceId, (trx) =>
    trx
      .updateTable('billing_documents')
      .set((eb) => ({ status: 'SENT', sent_at: deps.now(), version: eb('version', '+', 1) }))
      .where('id', '=', documentId)
      .execute(),
  );
  return { status: 'SENT', billingDocumentId: documentId, invoiceNumber };
}

export function createBillingActivities(deps: ActivityDependencies): BillingActivities {
  const notify = createNotificationActivity(deps);

  const tenantLocale = (tenantId: string, traceId: string): Promise<string> =>
    inTenant(
      deps,
      tenantId,
      traceId,
      async (trx) =>
        (
          await trx
            .selectFrom('tenants')
            .select(['default_locale'])
            .where('id', '=', tenantId)
            .executeTakeFirstOrThrow()
        ).default_locale,
    );

  return {
    notify,

    async issueInvoiceDocument(input: InvoiceIssuanceInput): Promise<InvoiceIssuanceResult> {
      try {
        return await issueInvoice(deps, input);
      } catch (error) {
        return providerFailure(error);
      }
    },

    async renewalSchedule(input: RenewalRemindersInput): Promise<RenewalSchedule> {
      const subscription = await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .selectFrom('subscriptions')
          .select(['plan_code', 'currency', 'current_period_end', 'status', 'cancel_at_period_end'])
          .where('stripe_subscription_id', '=', input.stripeSubscriptionId)
          .executeTakeFirst(),
      );
      if (subscription === undefined) {
        throw nonRetryable('subscription_missing', 'subscription is not recorded');
      }
      const periodEnd = new Date(input.periodEnd);
      if (Number.isNaN(periodEnd.getTime())) {
        throw nonRetryable('period_end_invalid', 'period end is not a timestamp');
      }
      const locale = await tenantLocale(input.tenantId, input.traceId);
      const plan = PLAN_CATALOG[subscription.plan_code as PlanCode];
      const price = plan.prices.find((candidate) => candidate.currency === subscription.currency);
      if (price === undefined) {
        throw nonRetryable(
          'plan_price_missing',
          `no ${subscription.currency} price for plan ${subscription.plan_code}`,
        );
      }
      return {
        steps: renewalReminderSteps(periodEnd).map((step) => ({
          at: step.at.toISOString(),
          notification: step.notification,
        })),
        payload: {
          plan_name: subscription.plan_code,
          renewal_date: formatDate(periodEnd, locale),
          amount_display: formatMinor(price.monthlyNetMinor, price.currency, locale),
        },
      };
    },

    async subscriptionRenewsAt(input: RenewalRemindersInput): Promise<boolean> {
      let state;
      try {
        state = await deps.billing.retrieveSubscription(input.stripeSubscriptionId);
      } catch (error) {
        return providerFailure(error);
      }
      return (
        (state.status === 'active' || state.status === 'trialing') &&
        !state.cancelAtPeriodEnd &&
        state.currentPeriodEnd !== null &&
        Math.abs(state.currentPeriodEnd.getTime() - Date.parse(input.periodEnd)) < 60_000
      );
    },

    async enterGracePeriod(input: DunningInput): Promise<GraceSchedule> {
      let invoice;
      try {
        invoice = await deps.billing.retrieveInvoice(input.stripeInvoiceId);
      } catch (error) {
        return providerFailure(error);
      }
      const locale = await tenantLocale(input.tenantId, input.traceId);
      const startedAt = await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const history = await trx
          .selectFrom('tenant_status_history')
          .select(['occurred_at'])
          .where('to_status', '=', 'GRACE_PERIOD')
          .where('reason', '=', `renewal_failed:${input.stripeInvoiceId}`)
          .orderBy('occurred_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (history !== undefined) {
          return history.occurred_at;
        }
        if (invoice.status === 'paid') {
          return null;
        }
        await applyTenantTransition(
          trx,
          input.tenantId,
          'RENEWAL_PAYMENT_FAILED',
          `renewal_failed:${input.stripeInvoiceId}`,
          input.traceId,
        );
        return deps.now();
      });
      const schedule = graceSteps(startedAt ?? deps.now());
      return {
        alreadyPaid: invoice.status === 'paid',
        reminderAt: schedule.reminder.at.toISOString(),
        finalDayAt: schedule.finalDay.at.toISOString(),
        suspendAt: schedule.suspendAt.toISOString(),
        payload: {
          amount_display: formatMinor(invoice.totalMinor, invoice.currency, locale),
          grace_ends_at: formatDateTime(schedule.suspendAt, locale),
        },
      };
    },

    async invoiceIsPaid(input: DunningInput): Promise<boolean> {
      try {
        return (await deps.billing.retrieveInvoice(input.stripeInvoiceId)).status === 'paid';
      } catch (error) {
        return providerFailure(error);
      }
    },

    async suspendForNonPayment(input: DunningInput): Promise<boolean> {
      return inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const tenant = await trx
          .selectFrom('tenants')
          .select(['status'])
          .where('id', '=', input.tenantId)
          .executeTakeFirstOrThrow();
        const event = tenant.status === 'RESTRICTED' ? 'RESTRICTION_EXPIRED' : 'GRACE_EXPIRED';
        return (
          await applyTenantTransition(
            trx,
            input.tenantId,
            event,
            `grace_expired:${input.stripeInvoiceId}`,
            input.traceId,
          )
        ).changed;
      });
    },
  };
}
