import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SecretValue, verifyStripeSignature } from '@velyric/security';
import {
  simulatorStripePrices,
  SIMULATOR_STRIPE_WEBHOOK_SECRET,
  startProviderSimulator,
  type ProviderSimulator,
} from '@velyric/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StripeSdkGateway } from '../src/billing/stripe-gateway.js';
import { HttpOAuthTokenClient, oauthEndpoints } from '../src/integrations/oauth.js';

interface CapturedWebhook {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let simulator: ProviderSimulator;
let receiver: Server;
const captured: CapturedWebhook[] = [];

beforeAll(async () => {
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      captured.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"received":true}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const port = (receiver.address() as AddressInfo).port;
  simulator = await startProviderSimulator({
    environment: 'ci',
    seed: 'control-api-adapters',
    stripePrices: simulatorStripePrices(),
    stripeWebhook: {
      url: `http://127.0.0.1:${String(port)}/stripe`,
      secret: SIMULATOR_STRIPE_WEBHOOK_SECRET,
    },
  });
});

afterAll(async () => {
  await simulator.close();
  await new Promise<void>((resolve) => {
    receiver.close(() => {
      resolve();
    });
  });
});

function followForm(html: string, action: string): URLSearchParams {
  const form =
    html.match(new RegExp(`<form method="post" action="${action}">(.*?)</form>`))?.[1] ?? '';
  const fields = new URLSearchParams();
  for (const input of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields.set(input[1] ?? '', (input[2] ?? '').replaceAll('&amp;', '&').replaceAll('&quot;', '"'));
  }
  return fields;
}

describe('provider simulator with real adapters', () => {
  it('runs Stripe checkout end to end through the Stripe SDK gateway with signed webhooks', async () => {
    const gateway = new StripeSdkGateway('sk_test_simulator', 'simulator', simulator.url);
    const customer = await gateway.createCustomer(
      {
        tenantId: '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f',
        billingProfileId: '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e60',
        email: 'szamla@demo-rendelo.test',
        name: 'Demo Rendelő Kft.',
        locale: 'hu',
        address: {
          country: 'HU',
          postalCode: '1051',
          city: 'Budapest',
          line1: 'Nádor utca 7.',
          line2: null,
        },
      },
      `customer-${randomBytes(6).toString('hex')}`,
    );
    await expect(gateway.customerExists(customer.id)).resolves.toBe(true);
    await expect(gateway.customerExists('cus_forgotten0000')).resolves.toBe(false);
    const prices = simulatorStripePrices();
    const plan = prices.find((price) => price.id.startsWith('price_sim_plan_start_'));
    const overage = prices.find((price) => price.id.startsWith('price_sim_overage_start_'));
    expect(plan).toBeDefined();
    const idempotencyKey = `checkout-${randomBytes(6).toString('hex')}`;
    const input = {
      orderId: '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e61',
      tenantId: '0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f',
      customerId: customer.id,
      planCode: 'START',
      pricingVersion: '2026-09-11.v6',
      lineItems: [
        { price: plan?.id ?? '', quantity: 1 },
        { price: overage?.id ?? '', quantity: null },
      ],
      successUrl:
        'http://app.velyric.test/app/onboarding/checkout/return?session={CHECKOUT_SESSION_ID}',
      cancelUrl: 'http://app.velyric.test/app/onboarding',
      locale: 'hu' as const,
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    const session = await gateway.createCheckoutSession(input, idempotencyKey);
    expect(await gateway.createCheckoutSession(input, idempotencyKey)).toEqual(session);
    expect(session.url).toBe(`${simulator.url}/stripe/checkout/${session.id}`);

    const page = await fetch(session.url);
    expect(await page.text()).toContain('Stripe Checkout simulator');
    const paid = await fetch(`${session.url}/pay`, { method: 'POST', redirect: 'manual' });
    expect(paid.status).toBe(303);
    expect(paid.headers.get('location')).toBe(
      `http://app.velyric.test/app/onboarding/checkout/return?session=${session.id}`,
    );
    await simulator.idle();

    const verified = await gateway.retrieveCheckoutSession(session.id);
    expect(verified).toMatchObject({
      status: 'complete',
      paymentStatus: 'paid',
      customerId: customer.id,
      amountTotal: plan?.unitAmount,
      currency: 'huf',
    });
    expect(verified.metadata).toMatchObject({
      internal_order_id: input.orderId,
      plan_code: 'START',
    });
    const subscription = await gateway.retrieveSubscription(verified.subscriptionId ?? '');
    expect(subscription).toMatchObject({
      status: 'ACTIVE',
      customerId: customer.id,
      cancelAtPeriodEnd: false,
    });
    expect(subscription.items.map((item) => item.priceId)).toEqual([plan?.id, overage?.id]);
    const invoice = await gateway.retrieveInvoice(verified.invoiceId ?? '');
    expect(invoice).toMatchObject({
      status: 'paid',
      amountPaid: plan?.unitAmount,
      subscriptionId: subscription.id,
    });

    const types = captured.map((webhook) => (JSON.parse(webhook.body) as { type: string }).type);
    expect(types).toEqual([
      'customer.subscription.created',
      'invoice.paid',
      'checkout.session.completed',
    ]);
    for (const webhook of captured) {
      const signature = webhook.headers['stripe-signature'];
      expect(() => {
        verifyStripeSignature(webhook.body, Array.isArray(signature) ? signature[0] : signature, [
          SIMULATOR_STRIPE_WEBHOOK_SECRET,
        ]);
      }).not.toThrow();
    }

    const dispute = await fetch(`${simulator.url}/_control/stripe/invoices/${invoice.id}/dispute`, {
      method: 'POST',
      body: '{}',
    });
    const disputeId = (await dispute.json()) as { id: string };
    await expect(gateway.retrieveDispute(disputeId.id)).resolves.toMatchObject({
      customerId: customer.id,
      status: 'needs_response',
      amount: plan?.unitAmount,
    });
    await expect(gateway.retrieveInvoice('in_missing')).rejects.toThrow(/No such invoice/);
    await expect(
      new StripeSdkGateway('sk_test_wrong', 'simulator', simulator.url).retrieveInvoice(invoice.id),
    ).rejects.toThrow(/Invalid API Key/);
  });

  it('completes the Google OAuth consent and PKCE code exchange used by calendar integrations', async () => {
    const endpoints = oauthEndpoints('google', 'simulator', simulator.url);
    const client = new HttpOAuthTokenClient(
      { google: endpoints, microsoft: oauthEndpoints('microsoft', 'simulator', simulator.url) },
      {
        google: {
          clientId: 'simulator-google',
          clientSecret: new SecretValue('simulator-google-secret'),
        },
        microsoft: {
          clientId: 'simulator-microsoft',
          clientSecret: new SecretValue('simulator-microsoft-secret'),
        },
      },
    );
    const codeVerifier = randomBytes(32).toString('base64url');
    const authorize = new URL(endpoints.authorizeUrl);
    authorize.search = new URLSearchParams({
      client_id: 'simulator-google',
      redirect_uri: 'http://api.velyric.test/v1/integrations/oauth/callback',
      response_type: 'code',
      scope: endpoints.scopes.join(' '),
      state: 'calendar-state',
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const consent = await fetch(authorize);
    const fields = followForm(await consent.text(), '/google/authorize/decision');
    fields.set('account', 'naptar@demo-rendelo.test');
    fields.set('decision', 'allow');
    const decided = await fetch(`${simulator.url}/google/authorize/decision`, {
      method: 'POST',
      body: fields,
      redirect: 'manual',
    });
    const code = new URL(decided.headers.get('location') ?? '').searchParams.get('code') ?? '';
    await expect(
      client.exchange({
        provider: 'google',
        code,
        codeVerifier: 'wrong-verifier',
        redirectUri: 'http://api.velyric.test/v1/integrations/oauth/callback',
      }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    const second = await fetch(`${simulator.url}/google/authorize/decision`, {
      method: 'POST',
      body: fields,
      redirect: 'manual',
    });
    const secondCode = new URL(second.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const exchanged = await client.exchange({
      provider: 'google',
      code: secondCode,
      codeVerifier,
      redirectUri: 'http://api.velyric.test/v1/integrations/oauth/callback',
    });
    expect(exchanged.accountRef).toBe('naptar@demo-rendelo.test');
    expect(exchanged.refreshToken.length).toBeGreaterThan(20);
    expect(exchanged.scopes).toEqual(endpoints.scopes);
  });

  it('injects provider faults through the control API', async () => {
    const gateway = new StripeSdkGateway('sk_test_simulator', 'simulator', simulator.url);
    const fault = await fetch(`${simulator.url}/_control/faults`, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'stripe',
        path_prefix: '/v1/invoices',
        status: 503,
        times: 5,
      }),
    });
    expect(fault.status).toBe(201);
    await expect(gateway.retrieveInvoice('in_any')).rejects.toThrow();
    await fetch(`${simulator.url}/_control/faults`, { method: 'DELETE' });
    await expect(gateway.retrieveInvoice('in_any')).rejects.toThrow(/No such invoice/);
  });
});
