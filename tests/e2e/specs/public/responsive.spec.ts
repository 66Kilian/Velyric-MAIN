import { expect, test, type Page } from '@playwright/test';
import { LOCALES, message } from '../../fixtures/messages.js';
import { localizedPath, type PublicLocale } from '../../fixtures/routes.js';

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

for (const locale of LOCALES) {
  test(`mobile navigation works without horizontal overflow (${locale})`, async ({ page }) => {
    await page.goto(`/${locale}`);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const toggle = page.getByRole('button', { name: message(locale, 'common.a11y.openMenu') });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    const menu = page.locator('#marketing-mobile-nav');
    await expect(menu).toBeVisible();
    await expect(
      page.getByRole('button', { name: message(locale, 'common.a11y.closeMenu') }),
    ).toHaveAttribute('aria-expanded', 'true');
    await menu
      .getByRole('link', { name: message(locale, 'navigation.marketing.pricing'), exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`${localizedPath('pricing', locale as PublicLocale)}$`),
    );
    await expect(menu).toBeHidden();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
}
