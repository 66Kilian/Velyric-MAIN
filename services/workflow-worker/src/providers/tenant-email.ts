import {
  classifySmtpError,
  createTenantSmtpTransport,
  parseTenantSmtpConfig,
  type SmtpCredential,
  type TenantSmtpSettings,
} from '@velyric/notifications/smtp';
import type { HostResolver } from '@velyric/security';
import type { VelyricEnvironment } from '@velyric/contracts';
import type { Transporter } from 'nodemailer';
import { SmtpEmailSender, type EmailSender } from './email.js';
import { ProviderCallError } from './errors.js';

export interface GoogleOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl: string;
}

export interface TenantEmailOptions {
  readonly environment: VelyricEnvironment;
  readonly resolver: HostResolver;
  readonly google: GoogleOAuthClient | null;
  readonly fetch?: typeof fetch;
}

export class TenantEmailUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'TenantEmailUnavailableError';
    this.reason = reason;
  }
}

export interface TenantSmtpCredentialSource {
  readonly authMethod: TenantSmtpSettings['authMethod'];
  readonly secret: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function googleAccessToken(
  refreshTokenSecret: string,
  options: TenantEmailOptions,
): Promise<string> {
  if (options.google === null) {
    throw new TenantEmailUnavailableError(
      'google_client_missing',
      'Google OAuth client credentials are not configured',
    );
  }
  let refreshToken: unknown;
  try {
    refreshToken = asRecord(JSON.parse(refreshTokenSecret))['refresh_token'];
  } catch {
    throw new TenantEmailUnavailableError(
      'secret_invalid',
      'stored Google credential is not valid JSON',
    );
  }
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new TenantEmailUnavailableError(
      'secret_invalid',
      'stored Google credential has no refresh token',
    );
  }
  const request = options.fetch ?? fetch;
  const response = await request(options.google.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: options.google.clientId,
      client_secret: options.google.clientSecret,
    }).toString(),
  });
  const body = asRecord(await response.json().catch(() => ({})));
  if (response.status === 400 || response.status === 401) {
    throw new TenantEmailUnavailableError(
      'auth_expired',
      'the Google authorization for this workspace has expired',
    );
  }
  const accessToken = body['access_token'];
  if (!response.ok || typeof accessToken !== 'string') {
    throw new ProviderCallError('smtp', 'token_refresh_failed', 'Google token refresh failed', {
      retryable: true,
      outcomeUnknown: false,
    });
  }
  return accessToken;
}

export async function tenantSmtpCredential(
  source: TenantSmtpCredentialSource,
  options: TenantEmailOptions,
): Promise<SmtpCredential> {
  return source.authMethod === 'GOOGLE_OAUTH'
    ? { kind: 'OAUTH', accessToken: await googleAccessToken(source.secret, options) }
    : { kind: 'PASSWORD', password: source.secret };
}

export interface TenantEmailSender extends EmailSender {
  readonly settings: TenantSmtpSettings;
  close(): void;
}

export function tenantSmtpSettings(config: unknown): TenantSmtpSettings {
  const settings = parseTenantSmtpConfig(config);
  if (settings === null) {
    throw new TenantEmailUnavailableError(
      'configuration_invalid',
      'the stored email configuration of this workspace is not usable',
    );
  }
  return settings;
}

export async function createTenantEmailSender(
  settings: TenantSmtpSettings,
  source: TenantSmtpCredentialSource,
  options: TenantEmailOptions,
): Promise<TenantEmailSender> {
  const credential = await tenantSmtpCredential(source, options);
  let transport: Transporter;
  try {
    transport = await createTenantSmtpTransport(settings, credential, {
      environment: options.environment,
      resolver: options.resolver,
    });
  } catch (error) {
    const classified = classifySmtpError(error);
    throw new ProviderCallError('smtp', classified.code, classified.message, {
      retryable: !classified.permanent,
      outcomeUnknown: false,
      cause: error,
    });
  }
  const sender = new SmtpEmailSender(
    transport,
    { name: settings.fromName, address: settings.fromAddress },
    settings.replyTo,
  );
  return {
    provider: 'smtp',
    settings,
    send: (email) => sender.send(email),
    close: () => {
      sender.close();
    },
  };
}
