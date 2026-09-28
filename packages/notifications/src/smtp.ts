import type { VelyricEnvironment } from '@velyric/contracts';
import {
  DEFAULT_EGRESS_POLICY,
  EgressBlockedError,
  resolveAllowedAddresses,
  type EgressPolicy,
  type HostResolver,
} from '@velyric/security';
import nodemailer, { type Transporter } from 'nodemailer';

export type SmtpSecurity = 'TLS' | 'STARTTLS' | 'NONE';

export type SmtpAuthMethod = 'PASSWORD' | 'GOOGLE_OAUTH';

export interface TenantSmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly username: string;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly replyTo: string | null;
  readonly authMethod: SmtpAuthMethod;
}

export type SmtpCredential =
  | { readonly kind: 'PASSWORD'; readonly password: string }
  | { readonly kind: 'OAUTH'; readonly accessToken: string };

export const GOOGLE_SMTP_HOST = 'smtp.gmail.com';

export const GOOGLE_SMTP_PRESET = Object.freeze({
  host: GOOGLE_SMTP_HOST,
  port: 465,
  security: 'TLS',
} as const);

export function googleOauthSettings(
  account: string,
  fromName: string,
  replyTo: string | null,
): TenantSmtpSettings {
  return {
    host: GOOGLE_SMTP_HOST,
    port: GOOGLE_SMTP_PRESET.port,
    security: GOOGLE_SMTP_PRESET.security,
    username: account,
    fromAddress: account,
    fromName,
    replyTo,
    authMethod: 'GOOGLE_OAUTH',
  };
}

export interface SmtpSettingsIssue {
  readonly path: string;
  readonly rule: string;
}

export const SMTP_PORTS: readonly number[] = Object.freeze([25, 465, 587, 2525]);

const HOSTNAME = /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]\.[a-z]{2,63}$/;
const EMAIL = /^[^\s@]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,63}$/i;
const LOCAL_PRIVATE_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
];

function developmentEnvironment(environment: VelyricEnvironment): boolean {
  return environment === 'local' || environment === 'ci';
}

export function isEmailAddress(value: string): boolean {
  return EMAIL.test(value);
}

export function smtpSettingsIssues(
  settings: TenantSmtpSettings,
  environment: VelyricEnvironment,
): readonly SmtpSettingsIssue[] {
  const issues: SmtpSettingsIssue[] = [];
  const development = developmentEnvironment(environment);
  const host = settings.host.toLowerCase();
  if (settings.authMethod === 'GOOGLE_OAUTH' && host !== GOOGLE_SMTP_HOST) {
    issues.push({ path: '/body/host', rule: 'google_oauth_requires_gmail_host' });
  }
  if (!HOSTNAME.test(host) && !(development && (host === 'localhost' || /^[0-9.]+$/.test(host)))) {
    issues.push({ path: '/body/host', rule: 'hostname' });
  }
  if (!SMTP_PORTS.includes(settings.port) && !development) {
    issues.push({ path: '/body/port', rule: 'port_not_allowed' });
  }
  if (settings.security === 'NONE' && !development) {
    issues.push({ path: '/body/security', rule: 'encryption_required' });
  }
  if (settings.security === 'TLS' && settings.port === 587) {
    issues.push({ path: '/body/security', rule: 'port_587_uses_starttls' });
  }
  if (settings.security === 'STARTTLS' && settings.port === 465) {
    issues.push({ path: '/body/security', rule: 'port_465_uses_tls' });
  }
  if (!isEmailAddress(settings.fromAddress)) {
    issues.push({ path: '/body/from_address', rule: 'email' });
  }
  if (settings.replyTo !== null && !isEmailAddress(settings.replyTo)) {
    issues.push({ path: '/body/reply_to', rule: 'email' });
  }
  if (/[\r\n<>"]/.test(settings.fromName)) {
    issues.push({ path: '/body/from_name', rule: 'invalid_characters' });
  }
  return issues;
}

export function parseTenantSmtpConfig(config: unknown): TenantSmtpSettings | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return null;
  }
  const value = config as Record<string, unknown>;
  const security = value['security'];
  const authMethod = value['auth_method'] ?? 'PASSWORD';
  if (authMethod !== 'PASSWORD' && authMethod !== 'GOOGLE_OAUTH') {
    return null;
  }
  if (
    typeof value['host'] !== 'string' ||
    typeof value['port'] !== 'number' ||
    !Number.isInteger(value['port']) ||
    (security !== 'TLS' && security !== 'STARTTLS' && security !== 'NONE') ||
    typeof value['username'] !== 'string' ||
    typeof value['from_address'] !== 'string' ||
    typeof value['from_name'] !== 'string' ||
    (value['reply_to'] !== null && typeof value['reply_to'] !== 'string')
  ) {
    return null;
  }
  return {
    host: value['host'],
    port: value['port'],
    security,
    username: value['username'],
    fromAddress: value['from_address'],
    fromName: value['from_name'],
    replyTo: value['reply_to'],
    authMethod,
  };
}

export function tenantSmtpConfigJson(settings: TenantSmtpSettings): Record<string, unknown> {
  return {
    host: settings.host.toLowerCase(),
    port: settings.port,
    security: settings.security,
    username: settings.username,
    from_address: settings.fromAddress,
    from_name: settings.fromName,
    reply_to: settings.replyTo,
    auth_method: settings.authMethod,
  };
}

export class SmtpConnectionError extends Error {
  readonly code: string;
  readonly permanent: boolean;

  constructor(code: string, message: string, permanent: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SmtpConnectionError';
    this.code = code;
    this.permanent = permanent;
  }
}

export function classifySmtpError(error: unknown): SmtpConnectionError {
  if (error instanceof SmtpConnectionError) {
    return error;
  }
  if (error instanceof EgressBlockedError) {
    return new SmtpConnectionError(
      `egress_${error.reason.toLowerCase()}`,
      'SMTP host is not reachable under the egress policy',
      true,
      error,
    );
  }
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const responseCode = typeof record['responseCode'] === 'number' ? record['responseCode'] : 0;
  const code = typeof record['code'] === 'string' ? record['code'] : '';
  if (code === 'EAUTH') {
    return new SmtpConnectionError('auth_failed', 'SMTP authentication failed', true, error);
  }
  if (
    code === 'ETLS' ||
    (code === 'ESOCKET' && /certificate|tls|ssl/i.test(String(record['message'])))
  ) {
    return new SmtpConnectionError('tls_failed', 'SMTP TLS negotiation failed', true, error);
  }
  if (responseCode >= 500) {
    return new SmtpConnectionError(
      `smtp_${String(responseCode)}`,
      'SMTP server rejected the message',
      true,
      error,
    );
  }
  if (responseCode >= 400) {
    return new SmtpConnectionError(
      `smtp_${String(responseCode)}`,
      'SMTP server deferred the message',
      false,
      error,
    );
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'EDNS' || code === 'ESOCKET') {
    return new SmtpConnectionError(
      'connection_failed',
      'SMTP server could not be reached',
      false,
      error,
    );
  }
  return new SmtpConnectionError('send_failed', 'SMTP delivery failed', false, error);
}

export interface TenantSmtpTransportOptions {
  readonly environment: VelyricEnvironment;
  readonly resolver: HostResolver;
}

export async function createTenantSmtpTransport(
  settings: TenantSmtpSettings,
  credential: SmtpCredential,
  options: TenantSmtpTransportOptions,
): Promise<Transporter> {
  const host = settings.host.toLowerCase();
  const development = developmentEnvironment(options.environment);
  const policy: EgressPolicy = {
    ...DEFAULT_EGRESS_POLICY,
    allowedHosts: [host],
    allowedPorts: development ? [settings.port] : SMTP_PORTS,
    trustedPrivateCidrs: development ? LOCAL_PRIVATE_CIDRS : [],
  };
  let address: string;
  try {
    const [first] = await resolveAllowedAddresses(host, policy, options.resolver);
    if (first === undefined) {
      throw new SmtpConnectionError('connection_failed', 'SMTP host has no address', false);
    }
    address = first.address;
  } catch (error) {
    throw classifySmtpError(error);
  }
  return nodemailer.createTransport({
    host: address,
    port: settings.port,
    secure: settings.security === 'TLS',
    requireTLS: settings.security === 'STARTTLS',
    ignoreTLS: settings.security === 'NONE',
    auth:
      credential.kind === 'PASSWORD'
        ? { user: settings.username, pass: credential.password }
        : { type: 'OAuth2', user: settings.username, accessToken: credential.accessToken },
    tls: { servername: host, minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

export async function verifyTenantSmtp(
  settings: TenantSmtpSettings,
  credential: SmtpCredential,
  options: TenantSmtpTransportOptions,
): Promise<void> {
  const transport = await createTenantSmtpTransport(settings, credential, options);
  try {
    await transport.verify();
  } catch (error) {
    throw classifySmtpError(error);
  } finally {
    transport.close();
  }
}
