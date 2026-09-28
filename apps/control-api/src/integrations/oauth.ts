import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { hmacSha256, type SecretValue } from '@velyric/security';

export type OAuthProvider = 'google' | 'microsoft';
export type ProviderMode = 'simulator' | 'sandbox' | 'live';
export type CalendarIntegrationType = 'GOOGLE_CALENDAR' | 'MICROSOFT_365';
export type OAuthIntegrationType = CalendarIntegrationType | 'CUSTOM_SMTP';

export const INTEGRATION_PROVIDER: Readonly<Record<OAuthIntegrationType, OAuthProvider>> = {
  GOOGLE_CALENDAR: 'google',
  MICROSOFT_365: 'microsoft',
  CUSTOM_SMTP: 'google',
};

export interface OAuthEndpoints {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly authorizeParams: Readonly<Record<string, string>>;
}

export interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: SecretValue;
}

export interface TokenExchangeInput {
  readonly provider: OAuthProvider;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export interface TokenExchangeResult {
  readonly refreshToken: string;
  readonly scopes: readonly string[];
  readonly accountRef: string | null;
}

export interface RefreshResult {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

export interface IdentityExchangeInput {
  readonly provider: OAuthProvider;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export interface IdentityExchangeResult {
  readonly email: string;
}

export interface OAuthTokenClient {
  exchange(input: TokenExchangeInput): Promise<TokenExchangeResult>;
  refresh(provider: OAuthProvider, refreshToken: string): Promise<RefreshResult>;
  exchangeIdentity(input: IdentityExchangeInput): Promise<IdentityExchangeResult>;
}

export class OAuthExchangeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OAuthExchangeError';
    this.code = code;
  }
}

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];
const MICROSOFT_SCOPES = [
  'openid',
  'email',
  'offline_access',
  'https://graph.microsoft.com/Calendars.ReadWrite',
];

export function oauthEndpoints(
  provider: OAuthProvider,
  mode: ProviderMode,
  simulatorUrl: string | null,
): OAuthEndpoints {
  const scopes = provider === 'google' ? GOOGLE_SCOPES : MICROSOFT_SCOPES;
  const authorizeParams: Record<string, string> =
    provider === 'google'
      ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }
      : { prompt: 'select_account' };
  if (mode === 'simulator') {
    if (simulatorUrl === null) {
      throw new RangeError('simulator mode requires a provider simulator URL');
    }
    const base = simulatorUrl.replace(/\/$/, '');
    return {
      authorizeUrl: `${base}/${provider}/authorize`,
      tokenUrl: `${base}/${provider}/token`,
      scopes,
      authorizeParams,
    };
  }
  return provider === 'google'
    ? {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes,
        authorizeParams,
      }
    : {
        authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        scopes,
        authorizeParams,
      };
}

const GOOGLE_MAIL_SCOPES = ['openid', 'email', 'https://mail.google.com/'];

export function endpointsForIntegration(
  integrationType: OAuthIntegrationType,
  endpoints: OAuthEndpoints,
): OAuthEndpoints {
  return integrationType === 'CUSTOM_SMTP'
    ? { ...endpoints, scopes: GOOGLE_MAIL_SCOPES }
    : endpoints;
}

export function calendarApiBaseUrl(
  provider: OAuthProvider,
  mode: ProviderMode,
  simulatorUrl: string | null,
): string {
  if (mode === 'simulator') {
    if (simulatorUrl === null) {
      throw new RangeError('simulator mode requires a provider simulator URL');
    }
    return `${simulatorUrl.replace(/\/$/, '')}/${provider}/api`;
  }
  return provider === 'google'
    ? 'https://www.googleapis.com/calendar/v3'
    : 'https://graph.microsoft.com/v1.0';
}

export function buildAuthorizeUrl(
  endpoints: OAuthEndpoints,
  clientId: string,
  input: { readonly state: string; readonly codeChallenge: string; readonly redirectUri: string },
): string {
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', endpoints.scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [name, value] of Object.entries(endpoints.authorizeParams)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function idTokenClaims(idToken: unknown): Record<string, unknown> | null {
  if (typeof idToken !== 'string') {
    return null;
  }
  const payload = idToken.split('.')[1];
  if (payload === undefined) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function verifiedEmailFromIdToken(provider: OAuthProvider, idToken: unknown): string | null {
  const claims = idTokenClaims(idToken);
  if (claims === null) {
    return null;
  }
  const email = claims['email'];
  if (typeof email !== 'string' || email === '' || email.length > 320) {
    return null;
  }
  if (provider === 'google' && claims['email_verified'] !== true) {
    return null;
  }
  return email.toLowerCase();
}

function accountFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') {
    return null;
  }
  const payload = idToken.split('.')[1];
  if (payload === undefined) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    for (const key of ['email', 'preferred_username', 'upn']) {
      const value = claims[key];
      if (typeof value === 'string' && value !== '' && value.length <= 320) {
        return value.toLowerCase();
      }
    }
  } catch {
    return null;
  }
  return null;
}

export class HttpOAuthTokenClient implements OAuthTokenClient {
  readonly #endpoints: Readonly<Record<OAuthProvider, OAuthEndpoints>>;
  readonly #clients: Readonly<Record<OAuthProvider, OAuthClientCredentials>>;
  readonly #fetch: typeof fetch;

  constructor(
    endpoints: Readonly<Record<OAuthProvider, OAuthEndpoints>>,
    clients: Readonly<Record<OAuthProvider, OAuthClientCredentials>>,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.#endpoints = endpoints;
    this.#clients = clients;
    this.#fetch = fetchImpl;
  }

  async #postToken(
    provider: OAuthProvider,
    body: URLSearchParams,
    fallbackErrorCode: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoints[provider].tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new OAuthExchangeError(
        'provider_unreachable',
        error instanceof Error ? error.name : 'fetch failed',
      );
    }
    let parsed: Record<string, unknown>;
    try {
      const json: unknown = await response.json();
      parsed =
        typeof json === 'object' && json !== null && !Array.isArray(json)
          ? (json as Record<string, unknown>)
          : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const code =
        typeof parsed['error'] === 'string' && /^[a-z_]{3,64}$/.test(parsed['error'])
          ? parsed['error']
          : fallbackErrorCode;
      throw new OAuthExchangeError(
        code,
        `token endpoint responded with HTTP ${String(response.status)}`,
      );
    }
    return parsed;
  }

  async refresh(provider: OAuthProvider, refreshToken: string): Promise<RefreshResult> {
    const client = this.#clients[provider];
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret.reveal(),
    });
    if (provider === 'microsoft') {
      body.set('scope', this.#endpoints.microsoft.scopes.join(' '));
    }
    const parsed = await this.#postToken(provider, body, 'token_refresh_failed');
    const accessToken = parsed['access_token'];
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new OAuthExchangeError(
        'access_token_missing',
        'the provider did not return an access token',
      );
    }
    const expiresIn = parsed['expires_in'];
    return {
      accessToken,
      expiresInSeconds: typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3_600,
    };
  }

  async exchange(input: TokenExchangeInput): Promise<TokenExchangeResult> {
    const client = this.#clients[input.provider];
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret.reveal(),
      code_verifier: input.codeVerifier,
    });
    const parsed = await this.#postToken(input.provider, body, 'token_exchange_failed');
    const refreshToken = parsed['refresh_token'];
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      throw new OAuthExchangeError(
        'refresh_token_missing',
        'the provider did not grant offline access',
      );
    }
    const scope =
      typeof parsed['scope'] === 'string'
        ? parsed['scope']
        : this.#endpoints[input.provider].scopes.join(' ');
    return {
      refreshToken,
      scopes: scope.split(' ').filter((item) => item !== ''),
      accountRef: accountFromIdToken(parsed['id_token']),
    };
  }

  async exchangeIdentity(input: IdentityExchangeInput): Promise<IdentityExchangeResult> {
    const client = this.#clients[input.provider];
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret.reveal(),
      code_verifier: input.codeVerifier,
    });
    const parsed = await this.#postToken(input.provider, body, 'token_exchange_failed');
    const email = verifiedEmailFromIdToken(input.provider, parsed['id_token']);
    if (email === null) {
      throw new OAuthExchangeError(
        'email_unverified',
        'the provider did not return a verified email address',
      );
    }
    return { email };
  }
}

const SEAL_VERSION = 1;

function sealingKey(stateKey: Uint8Array): Buffer {
  return hmacSha256(stateKey, 'velyric:oauth-pkce:v1');
}

export function sealVerifier(stateKey: Uint8Array, verifier: string, context: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(stateKey), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(verifier, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function unsealVerifier(
  stateKey: Uint8Array,
  sealed: Uint8Array,
  context: string,
): string | null {
  const buffer = Buffer.from(sealed);
  if (buffer.length < 30 || buffer[0] !== SEAL_VERSION) {
    return null;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(stateKey), buffer.subarray(1, 13));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(buffer.subarray(13, 29));
    return Buffer.concat([decipher.update(buffer.subarray(29)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
