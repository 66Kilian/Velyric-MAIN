import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';

export function simulatorUrl(): string {
  return (process.env['VELYRIC_PROVIDER_SIMULATOR_URL'] ?? 'http://127.0.0.1:4010').replace(
    /\/$/,
    '',
  );
}

export function syntheticEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}@e2e.velyric.test`;
}

export async function simulatorHealthy(request: APIRequestContext): Promise<boolean> {
  try {
    const response = await request.get(`${simulatorUrl()}/_control/health`, { timeout: 2_000 });
    return response.ok();
  } catch {
    return false;
  }
}

export const SYNTHETIC_PASSWORD = 'Correct-Horse-9';

export async function registerViaForm(
  page: Page,
  input: { readonly email: string; readonly password?: string },
): Promise<void> {
  await page.goto('/en/signup');
  await page.getByLabel('Email address').fill(input.email);
  await page.getByLabel('Password').fill(input.password ?? SYNTHETIC_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}
