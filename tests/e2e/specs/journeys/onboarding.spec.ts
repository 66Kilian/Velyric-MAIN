import { expect, test } from '@playwright/test';
import { expectAccessible } from '../../fixtures/a11y.js';
import { message, plain } from '../../fixtures/messages.js';
import { registerViaForm, simulatorHealthy, syntheticEmail } from '../../fixtures/simulator.js';

const HU_TAX_NUMBER = '12345676-2-41';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context, request, baseURL }) => {
  test.skip(
    !(await simulatorHealthy(request)),
    'provider simulator is not reachable; start the local stack with pnpm dev',
  );
  await context.addCookies([
    { name: 'NEXT_LOCALE', value: 'en', url: baseURL ?? 'http://localhost:3000' },
  ]);
});

test('a new customer signs in, creates a workspace, pays and reaches provisioning', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const email = syntheticEmail('owner');
  const slug = `e2e-${Date.now().toString(36)}`;
  await registerViaForm(page, { email });

  await expect(page).toHaveURL(/\/app\/onboarding$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    message('en', 'onboarding.headings.workspace.title'),
  );
  const session = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'vly_session',
  );
  expect(session?.httpOnly).toBe(true);
  await expectAccessible(page, testInfo);

  await page.getByLabel(message('en', 'onboarding.workspace.displayName')).fill('Kovács Fogászat');
  await page
    .getByLabel(message('en', 'onboarding.workspace.legalName'))
    .fill('Kovács Fogászat Kft.');
  await page.getByLabel(message('en', 'onboarding.workspace.slug')).fill(slug);
  await page.getByLabel(message('en', 'onboarding.workspace.country')).selectOption('HU');
  await page.getByLabel(message('en', 'onboarding.workspace.language')).selectOption('hu');
  await page
    .getByLabel(message('en', 'onboarding.workspace.locationName'))
    .fill('Budapest rendelő');
  await page.getByRole('button', { name: message('en', 'onboarding.workspace.submit') }).click();

  await expect(page).toHaveURL(/\/app\/onboarding\?workspace=[0-9a-f-]{36}&step=billing$/);
  const workspaceId = new URL(page.url()).searchParams.get('workspace') ?? '';
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    message('en', 'onboarding.headings.billing.title'),
  );

  await page.getByLabel(message('en', 'onboarding.billing.billingEmail')).fill(email);
  await page.getByLabel(message('en', 'onboarding.billing.postalCode')).fill('1052');
  await page.getByLabel(message('en', 'onboarding.billing.city')).fill('Budapest');
  await page
    .getByLabel(message('en', 'onboarding.billing.address'), { exact: true })
    .fill('Váci utca 1.');
  await page.getByLabel(message('en', 'onboarding.billing.huTaxNumber')).fill(HU_TAX_NUMBER);
  await page.getByRole('button', { name: message('en', 'onboarding.billing.submit') }).click();

  await expect(page).toHaveURL(new RegExp(`workspace=${workspaceId}&step=plan$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    message('en', 'onboarding.headings.plan.title'),
  );
  const plans = page.getByRole('radiogroup', { name: message('en', 'onboarding.plan.choose') });
  await plans
    .getByRole('radio', { name: new RegExp(message('en', 'onboarding.plan.plans.BUSINESS.name')) })
    .click();
  const checkout = page.getByRole('button', { name: message('en', 'onboarding.plan.checkout') });
  await expect(checkout).toBeDisabled();
  await page.getByRole('checkbox').check();
  await expect(checkout).toBeEnabled();
  await checkout.click();

  await page.waitForURL((url) => url.pathname.startsWith('/stripe/checkout/'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Stripe Checkout simulator');
  await page.getByRole('button', { name: /^Pay / }).click();

  await page.waitForURL((url) => url.pathname === '/app/onboarding/checkout/return');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    message('en', 'checkout.return.paidTitle'),
    { timeout: 90_000 },
  );
  await page.getByRole('link', { name: message('en', 'checkout.return.continue') }).click();
  await expect(page).toHaveURL(new RegExp(`workspace=${workspaceId}&step=provisioning$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    message('en', 'onboarding.headings.provisioning.title'),
  );
});

test('a declined card keeps the order unpaid and offers a retry', async ({ page }) => {
  test.setTimeout(180_000);
  const email = syntheticEmail('declined');
  await registerViaForm(page, { email });
  await expect(page).toHaveURL(/\/app\/onboarding$/);

  await page.getByLabel(message('en', 'onboarding.workspace.displayName')).fill('Nagy Autószerviz');
  await page
    .getByLabel(message('en', 'onboarding.workspace.legalName'))
    .fill('Nagy Autószerviz Bt.');
  await page
    .getByLabel(message('en', 'onboarding.workspace.slug'))
    .fill(`e2e-declined-${Date.now().toString(36)}`);
  await page.getByLabel(message('en', 'onboarding.workspace.locationName')).fill('Győr');
  await page.getByRole('button', { name: message('en', 'onboarding.workspace.submit') }).click();
  await expect(page).toHaveURL(/step=billing$/);

  await page.getByLabel(message('en', 'onboarding.billing.billingEmail')).fill(email);
  await page.getByLabel(message('en', 'onboarding.billing.postalCode')).fill('9021');
  await page.getByLabel(message('en', 'onboarding.billing.city')).fill('Győr');
  await page
    .getByLabel(message('en', 'onboarding.billing.address'), { exact: true })
    .fill('Baross Gábor út 2.');
  await page.getByLabel(message('en', 'onboarding.billing.huTaxNumber')).fill(HU_TAX_NUMBER);
  await page.getByRole('button', { name: message('en', 'onboarding.billing.submit') }).click();
  await expect(page).toHaveURL(/step=plan$/);

  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: message('en', 'onboarding.plan.checkout') }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/stripe/checkout/'));
  await page.getByRole('button', { name: 'Simulate declined card' }).click();
  await expect(page.getByRole('alert')).toHaveText('Your card was declined.');
  await page.getByRole('link', { name: 'Cancel' }).click();

  await expect(page).toHaveURL(/step=plan&checkout=canceled$/);
  await expect(page.getByText(plain(message('en', 'onboarding.plan.canceled')))).toBeVisible();
});

test('workspace pages reject members of other tenants', async ({ page }) => {
  const email = syntheticEmail('outsider');
  await registerViaForm(page, { email });
  await expect(page).toHaveURL(/\/app\/onboarding$/);
  const response = await page.goto(
    '/app/onboarding?workspace=01890000-0000-7000-8000-000000000000&step=billing',
  );
  expect(response?.status()).toBe(404);
});
