import { randomBytes } from 'node:crypto';
import {
  simulatorStripePrices,
  startProviderSimulator,
  type ProviderSimulator,
} from '@velyric/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpBillingoApi } from '../src/providers/billingo.js';
import { ProviderCallError } from '../src/providers/errors.js';
import { OpenAiSdkProjectAdmin } from '../src/providers/openai-admin.js';
import { StripeSdkBillingGateway } from '../src/providers/stripe.js';
import { TelnyxSdkCarrier } from '../src/providers/telnyx.js';

let simulator: ProviderSimulator;

beforeAll(async () => {
  simulator = await startProviderSimulator({
    environment: 'ci',
    seed: 'workflow-worker-adapters',
    stripePrices: simulatorStripePrices(),
    telnyxOrderApprovalMs: 0,
  });
});

afterAll(async () => {
  await simulator.close();
});

async function control(path: string, body: unknown): Promise<Response> {
  return fetch(`${simulator.url}${path}`, { method: 'POST', body: JSON.stringify(body) });
}

async function stripeForm(
  path: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${simulator.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk_test_simulator',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('provider simulator with workflow-worker adapters', () => {
  it('orders a regulated Hungarian number through the Telnyx SDK carrier', async () => {
    const carrier = new TelnyxSdkCarrier('KEY_simulator', `${simulator.url}/telnyx/v2`);
    const reference = `order-${randomBytes(4).toString('hex')}`;
    const available = await carrier.searchAvailable('HU', 'local', 5);
    expect(available).toHaveLength(5);
    expect(available[0]?.e164).toMatch(/^\+361\d{7}$/);
    const e164 = available[0]?.e164 ?? '';
    const reservation = await carrier.reserve(e164, reference);
    expect(reservation.expiresAt).not.toBeNull();
    await expect(carrier.reserve(e164, 'someone-else')).rejects.toBeInstanceOf(ProviderCallError);

    const requirements = await carrier.requirements('HU', 'local');
    expect(requirements.map((requirement) => requirement.fieldType).sort()).toEqual([
      'ADDRESS',
      'DOCUMENT',
      'TEXTUAL',
    ]);
    const document = await carrier.uploadDocument(
      'cegkivonat.pdf',
      Buffer.from('%PDF-1.7 synthetic').toString('base64'),
      reference,
    );
    const address = await carrier.createAddress(
      {
        businessName: 'Demo Rendelő Kft.',
        firstName: 'Réka',
        lastName: 'Kovács',
        streetAddress: 'Nádor utca 7.',
        extendedAddress: null,
        locality: 'Budapest',
        postalCode: '1051',
        countryCode: 'HU',
      },
      reference,
    );
    const values = requirements.map((requirement) => ({
      requirementId: requirement.requirementId,
      value:
        requirement.fieldType === 'DOCUMENT'
          ? document
          : requirement.fieldType === 'ADDRESS'
            ? address
            : 'Kovács Réka',
    }));
    const group = await carrier.createRequirementGroup('HU', 'local', reference, values);
    await expect(
      carrier.createOrder(e164, 'connection-simulator', reference, null),
    ).rejects.toBeInstanceOf(ProviderCallError);
    const order = await carrier.createOrder(e164, 'connection-simulator', reference, group);
    expect(order.orderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await carrier.findOrderByReference(reference)).toMatchObject({ orderId: order.orderId });
    expect(await carrier.retrieveOrder(order.orderId)).toMatchObject({
      status: 'success',
      requirementsStatus: 'approved',
    });
    expect(
      (await carrier.searchAvailable('HU', 'local', 25)).map((entry) => entry.e164),
    ).not.toContain(e164);

    await control('/_control/telnyx/regulatory', { decision: 'decline' });
    const second = available[1]?.e164 ?? '';
    const secondReference = `${reference}-declined`;
    await carrier.reserve(second, secondReference);
    const declined = await carrier.createOrder(
      second,
      'connection-simulator',
      secondReference,
      await carrier.createRequirementGroup('HU', 'local', secondReference, values),
    );
    expect(await carrier.retrieveOrder(declined.orderId)).toMatchObject({
      status: 'failure',
      requirementsStatus: 'requirement-info-exception',
    });
    await control('/_control/telnyx/regulatory', { decision: 'approve' });

    await control('/_control/telnyx/inventory', {
      country: 'HU',
      number_type: 'toll_free',
      available: false,
    });
    expect(await carrier.searchAvailable('HU', 'toll_free', 5)).toEqual([]);
    await expect(
      new TelnyxSdkCarrier('KEY_wrong', `${simulator.url}/telnyx/v2`).searchAvailable(
        'HU',
        'local',
        1,
      ),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('provisions an OpenAI project, spend limit and service account keys through the admin SDK', async () => {
    const admin = new OpenAiSdkProjectAdmin('sk-admin-simulator', `${simulator.url}/openai/v1`);
    const name = `velyric-tenant-${randomBytes(4).toString('hex')}`;
    expect(await admin.findProjectByName(name)).toBeNull();
    const projectId = await admin.createProject(name);
    expect(await admin.findProjectByName(name)).toBe(projectId);
    await admin.setMonthlySpendLimit(projectId, 120);
    const created = await admin.createServiceAccount(projectId, 'voice-runtime');
    expect(created.credential?.apiKey).toMatch(/^sk-svcacct-/);
    expect(await admin.findServiceAccount(projectId, 'voice-runtime')).toBe(
      created.serviceAccountId,
    );
    const rotated = await admin.createServiceAccountKey(
      projectId,
      created.serviceAccountId,
      'rotation',
    );
    expect(rotated.apiKey).not.toBe(created.credential?.apiKey);

    await control('/_control/faults', {
      provider: 'openai',
      path_prefix: '/v1/organization/projects',
      status: 429,
      times: 10,
    });
    await expect(admin.createProject(`${name}-limited`)).rejects.toMatchObject({ retryable: true });
    await fetch(`${simulator.url}/_control/faults`, { method: 'DELETE' });
  });

  it('creates and sends Billingo invoices through the HTTP adapter', async () => {
    const billingo = new HttpBillingoApi('billingo-simulator', `${simulator.url}/billingo/v3`);
    const partnerId = await billingo.createPartner({
      name: 'Demo Rendelő Kft.',
      countryCode: 'HU',
      postCode: '1051',
      city: 'Budapest',
      address: 'Nádor utca 7.',
      emails: ['szamla@demo-rendelo.test'],
      taxCode: '12345678-2-41',
      taxType: 'HAS_TAX_NUMBER',
    });
    const invoice = await billingo.createInvoice({
      partnerId,
      blockId: 1,
      fulfillmentDate: '2026-09-15',
      dueDate: '2026-09-15',
      language: 'hu',
      currency: 'HUF',
      items: [
        {
          name: 'Velyric START előfizetés',
          netUnitPrice: 39_900,
          quantity: 1,
          unit: 'hó',
          vat: '27%',
        },
      ],
      comment: 'Stripe invoice in_simulated',
      orderNumber: 'order-1',
    });
    expect(invoice.invoiceNumber).toMatch(/^VLY-\d{4}-\d{6}$/);
    await billingo.sendInvoice(invoice.id, ['szamla@demo-rendelo.test']);
    const state = (await (await fetch(`${simulator.url}/_control/billingo/documents`)).json()) as {
      sent: unknown[];
    };
    expect(state.sent).toEqual([{ documentId: invoice.id, emails: ['szamla@demo-rendelo.test'] }]);
    await expect(
      new HttpBillingoApi('wrong', `${simulator.url}/billingo/v3`).sendInvoice(invoice.id, [
        'a@b.test',
      ]),
    ).rejects.toBeInstanceOf(ProviderCallError);
  });

  it('reads paid invoices and subscriptions through the Stripe billing gateway', async () => {
    const customer = await stripeForm('/v1/customers', {
      email: 'szamla@demo-rendelo.test',
      name: 'Demo Rendelő Kft.',
    });
    const plan = simulatorStripePrices().find((price) =>
      price.id.startsWith('price_sim_plan_business_'),
    );
    const session = await stripeForm('/v1/checkout/sessions', {
      mode: 'subscription',
      customer: String(customer['id']),
      'line_items[0][price]': plan?.id ?? '',
      'line_items[0][quantity]': '1',
      success_url: 'http://app.velyric.test/done',
    });
    const paid = await fetch(`${String(session['url'])}/pay`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(paid.status).toBe(303);
    const completed = (await (
      await fetch(`${simulator.url}/v1/checkout/sessions/${String(session['id'])}`, {
        headers: { authorization: 'Bearer sk_test_simulator' },
      })
    ).json()) as Record<string, string>;
    const gateway = new StripeSdkBillingGateway('sk_test_simulator', simulator.url);
    const invoice = await gateway.retrieveInvoice(completed['invoice'] ?? '');
    expect(invoice).toMatchObject({
      status: 'paid',
      currency: 'HUF',
      totalMinor: plan?.unitAmount,
      subscriptionId: completed['subscription'],
    });
    expect(invoice.paidAt).not.toBeNull();
    expect(invoice.lines).toHaveLength(1);
    const subscription = await gateway.retrieveSubscription(completed['subscription'] ?? '');
    expect(subscription).toBeDefined();
  });
});
