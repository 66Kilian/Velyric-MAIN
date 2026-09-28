import type { Router } from './http.js';
import type { DeterministicIds } from './state.js';
import type { WebhookDispatcher, WebhookTarget } from './webhooks.js';

export interface SyntheticUser {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SimulatorCredentials {
  readonly workosApiKey: string;
  readonly workosClientId: string;
  readonly stripeSecretKey: string;
  readonly openaiAdminKey: string;
  readonly telnyxApiKey: string;
  readonly billingoApiKey: string;
  readonly google: OAuthClient;
  readonly microsoft: OAuthClient;
}

export interface StripePrice {
  readonly id: string;
  readonly unitAmount: number;
  readonly currency: string;
  readonly usageType: 'licensed' | 'metered';
}

export interface ResolvedSimulatorConfig {
  readonly seed: string;
  readonly publicUrl: string;
  readonly credentials: SimulatorCredentials;
  readonly users: readonly SyntheticUser[];
  readonly calendarAccounts: readonly string[];
  readonly stripePrices: readonly StripePrice[];
  readonly stripeWebhook: WebhookTarget | null;
  readonly openaiWebhook: WebhookTarget | null;
  readonly telnyxOrderApprovalMs: number;
}

export interface SimulatorContext {
  readonly config: ResolvedSimulatorConfig;
  readonly ids: DeterministicIds;
  readonly webhooks: WebhookDispatcher;
  readonly now: () => Date;
}

export interface ProviderModule {
  register(api: Router, control: Router): void;
  snapshot(): Record<string, number>;
}

export const DEFAULT_CREDENTIALS: SimulatorCredentials = {
  workosApiKey: 'sk_test_simulator',
  workosClientId: 'client_simulator',
  stripeSecretKey: 'sk_test_simulator',
  openaiAdminKey: 'sk-admin-simulator',
  telnyxApiKey: 'KEY_simulator',
  billingoApiKey: 'billingo-simulator',
  google: { clientId: 'simulator-google', clientSecret: 'simulator-google-secret' },
  microsoft: { clientId: 'simulator-microsoft', clientSecret: 'simulator-microsoft-secret' },
};

export const DEFAULT_USERS: readonly SyntheticUser[] = [
  { email: 'owner@demo-rendelo.test', firstName: 'Réka', lastName: 'Kovács' },
  { email: 'operator@demo-rendelo.test', firstName: 'Bence', lastName: 'Nagy' },
  { email: 'analyst@demo-rendelo.test', firstName: 'Lena', lastName: 'Fischer' },
];

export const DEFAULT_CALENDAR_ACCOUNTS: readonly string[] = [
  'naptar@demo-rendelo.test',
  'kalender@praxis-weber.test',
];

export const SIMULATOR_STRIPE_WEBHOOK_SECRET = 'whsec_simulator';
export const SIMULATOR_OPENAI_WEBHOOK_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
