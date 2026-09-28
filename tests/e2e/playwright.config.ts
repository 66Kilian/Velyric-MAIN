import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const envFile = `${repoRoot}.env`;
if (process.env['VELYRIC_E2E_SKIP_ENV_FILE'] !== '1' && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const ci = process.env['CI'] === 'true';
const externalBaseUrl = process.env['VELYRIC_E2E_BASE_URL'];
const baseURL = (
  externalBaseUrl ??
  process.env['VELYRIC_PUBLIC_WEB_ORIGIN'] ??
  'http://localhost:3000'
).replace(/\/$/, '');
const simulatorUrl = process.env['VELYRIC_PROVIDER_SIMULATOR_URL'] ?? 'http://127.0.0.1:4010';
const controlApiUrl = process.env['VELYRIC_CONTROL_API_URL'] ?? 'http://127.0.0.1:4000';

function server(name: string, command: string, url: string) {
  return {
    name,
    command,
    url,
    cwd: repoRoot,
    reuseExistingServer: !ci,
    timeout: 180_000,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
  };
}

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  ...(ci ? { workers: 2 } : {}),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: ci
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    locale: 'en-GB',
    timezoneId: 'Europe/Budapest',
    trace: ci ? 'retain-on-failure' : 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'public',
      testMatch: /public\/.*\.spec\.ts$/,
      testIgnore: /responsive\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'public-mobile',
      testMatch: /public\/responsive\.spec\.ts$/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'journeys',
      testMatch: /journeys\/.*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(externalBaseUrl === undefined
    ? {
        webServer: [
          server(
            'provider-simulator',
            'pnpm --filter @velyric/testkit run provider-simulator',
            `${simulatorUrl}/_control/health`,
          ),
          server(
            'control-api',
            'pnpm --filter @velyric/control-api run start',
            `${controlApiUrl}/healthz/live`,
          ),
          server('web', 'pnpm --filter @velyric/web run start', `${baseURL}/api/healthz/live`),
        ],
      }
    : {}),
});
