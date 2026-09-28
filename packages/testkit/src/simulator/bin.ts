import { randomUUID } from 'node:crypto';
import { SIMULATOR_OPENAI_WEBHOOK_SECRET, SIMULATOR_STRIPE_WEBHOOK_SECRET } from './context.js';
import { simulatorStripePrices } from './prices.js';
import { SimulatorEnvironmentError, startProviderSimulator } from './server.js';

function simulatorSeed(): string {
  const base = process.env['VELYRIC_SIMULATOR_SEED'] ?? 'velyric-local';
  return process.env['VELYRIC_SIMULATOR_STABLE_IDS'] === 'true' ? base : `${base}:${randomUUID()}`;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    process.stderr.write(`CONFIG_INVALID: ${name} must be an integer between 0 and 65535\n`);
    process.exit(78);
  }
  return value;
}

function target(
  urlVariable: string,
  fallbackUrl: string,
  secretVariable: string,
  fallbackSecret: string,
) {
  const url = process.env[urlVariable] ?? fallbackUrl;
  if (url === '' || url === 'off') {
    return null;
  }
  if (!URL.canParse(url)) {
    process.stderr.write(`CONFIG_INVALID: ${urlVariable} must be a URL or "off"\n`);
    process.exit(78);
  }
  return { url, secret: process.env[secretVariable] ?? fallbackSecret };
}

async function main(): Promise<void> {
  const environment = process.env['VELYRIC_ENV'] ?? '';
  try {
    const simulator = await startProviderSimulator({
      environment,
      host: process.env['VELYRIC_PROVIDER_SIMULATOR_HOST'] ?? '127.0.0.1',
      port: positiveInteger('VELYRIC_PROVIDER_SIMULATOR_PORT', 4010),
      seed: simulatorSeed(),
      sequenceOffset:
        process.env['VELYRIC_SIMULATOR_STABLE_IDS'] === 'true' ? 0 : Math.floor(Date.now() / 1000),
      ...(process.env['VELYRIC_PROVIDER_SIMULATOR_PUBLIC_URL'] === undefined
        ? {}
        : { publicUrl: process.env['VELYRIC_PROVIDER_SIMULATOR_PUBLIC_URL'] }),
      stripePrices: simulatorStripePrices(),
      stripeWebhook: target(
        'VELYRIC_SIMULATOR_STRIPE_WEBHOOK_URL',
        'http://127.0.0.1:4000/v1/webhooks/providers/stripe',
        'VELYRIC_STRIPE_WEBHOOK_SIGNING_SECRET',
        SIMULATOR_STRIPE_WEBHOOK_SECRET,
      ),
      openaiWebhook: target(
        'VELYRIC_SIMULATOR_OPENAI_WEBHOOK_URL',
        'http://127.0.0.1:7000/v1/webhooks/openai/live',
        'VELYRIC_OPENAI_WEBHOOK_SECRET',
        SIMULATOR_OPENAI_WEBHOOK_SECRET,
      ),
      telnyxOrderApprovalMs: positiveInteger('VELYRIC_SIMULATOR_TELNYX_APPROVAL_MS', 2_000),
    });
    process.stdout.write(`provider simulator listening on ${simulator.url}\n`);
    const shutdown = (): void => {
      void simulator.close().finally(() => {
        process.exit(0);
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    if (error instanceof SimulatorEnvironmentError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(78);
    }
    throw error;
  }
}

await main();
