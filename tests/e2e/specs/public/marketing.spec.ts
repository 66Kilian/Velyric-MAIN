import { expect, test } from '@playwright/test';
import { expectAccessible } from '../../fixtures/a11y.js';
import { LOCALES, message, plain } from '../../fixtures/messages.js';
import { localizedPath, publicPaths, type PublicLocale } from '../../fixtures/routes.js';

for (const locale of LOCALES) {
  test.describe(`marketing site (${locale})`, () => {
    for (const path of publicPaths(locale as PublicLocale)) {
      test(`renders ${path} accessibly`, async ({ page }, testInfo) => {
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.locator('main')).toBeVisible();
        const canonical = page.locator('link[rel="canonical"]');
        if ((await canonical.count()) > 0) {
          expect(await canonical.getAttribute('href')).toContain(`/${locale}`);
        }
        await expectAccessible(page, testInfo);
      });
    }

    test('sign-in entry uses the localized copy and a sanitized return path', async ({ page }) => {
      await page.goto(
        `${localizedPath('login', locale as PublicLocale)}?return_to=${encodeURIComponent('//evil.example/app')}`,
      );
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        message(locale, 'auth.signIn.title'),
      );
      const cta = page.getByRole('link', { name: message(locale, 'auth.signIn.button') });
      const href = await cta.getAttribute('href');
      expect(href).not.toBeNull();
      const target = new URL(href ?? '', 'http://placeholder.invalid');
      expect(target.pathname).toBe('/api/auth/sign-in');
      expect(target.searchParams.get('screen')).toBe('sign-in');
      expect(target.searchParams.get('return_to')).toBe('/app');
    });

    test('sign-up entry links back to sign-in', async ({ page }) => {
      await page.goto(localizedPath('signup', locale as PublicLocale));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        message(locale, 'auth.signUp.title'),
      );
      await page
        .locator('main')
        .getByRole('link', { name: plain(message(locale, 'auth.signUp.switchLink')), exact: true })
        .click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/login$`));
    });
  });
}

test('skip link moves focus to the main landmark', async ({ page }) => {
  await page.goto(localizedPath('pricing', 'en'));
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: message('en', 'common.a11y.skipToContent') });
  await expect(skip).toBeFocused();
  await skip.press('Enter');
  await expect(page).toHaveURL(/#main$/);
});

test.describe('locale-neutral pages', () => {
  for (const document of ['privacy', 'terms', 'dpa']) {
    test(`legal document ${document} renders accessibly`, async ({ page }, testInfo) => {
      const response = await page.goto(`/legal/${document}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expectAccessible(page, testInfo);
    });
  }

  test('unknown legal document is a 404', async ({ page }) => {
    const response = await page.goto('/legal/not-a-document');
    expect(response?.status()).toBe(404);
  });

  test('status page renders', async ({ page }, testInfo) => {
    const response = await page.goto('/status');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectAccessible(page, testInfo);
  });

  test('unknown solution vertical is a 404', async ({ page }) => {
    const response = await page.goto('/en/solutions/not-a-vertical');
    expect(response?.status()).toBe(404);
  });
});
