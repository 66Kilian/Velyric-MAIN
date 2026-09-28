import { timingSafeEqual } from 'node:crypto';
import { createPkcePair, randomToken, sha256Hex, signState, verifyState } from '@velyric/security';
import Type from 'typebox';
import { headerValue, type RouteModule } from '../app.js';
import {
  issueSession,
  loginOrRegisterWithGoogle,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from '../auth.js';
import { ApiError } from '../errors.js';
import {
  OAuthExchangeError,
  sealVerifier,
  unsealVerifier,
  type OAuthEndpoints,
  type OAuthTokenClient,
} from '../integrations/oauth.js';
import { cookieOptions } from './auth.js';

export interface SocialAuthRouteDependencies {
  readonly tokenClient: OAuthTokenClient;
  readonly google: { readonly endpoints: OAuthEndpoints; readonly clientId: string };
  readonly publicApiOrigin: string;
  readonly webOrigin: string;
  readonly sessionSecret: string;
  readonly cookieDomain: string | null;
}

const LOGIN_SCOPES = ['openid', 'email'];
const STATE_TTL_SECONDS = 600;
const SEAL_CONTEXT = 'auth.google.login';
const NONCE_COOKIE_NAME = 'vly_oauth_nonce';
const NONCE_COOKIE_OPTIONS = (
  environment: string,
  cookieDomain: string | null,
): {
  readonly path: string;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly maxAge: number;
  readonly domain?: string;
} => ({
  path: '/v1/auth/google',
  httpOnly: true,
  secure: environment === 'staging' || environment === 'production',
  sameSite: 'lax',
  maxAge: STATE_TTL_SECONDS,
  ...(cookieDomain === null ? {} : { domain: cookieDomain }),
});

const StartQuery = Type.Object(
  { return_to: Type.Optional(Type.String({ maxLength: 512 })) },
  { additionalProperties: false },
);

const CallbackQuery = Type.Object(
  {
    state: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    error: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    error_description: Type.Optional(Type.String({ maxLength: 2000 })),
    scope: Type.Optional(Type.String({ maxLength: 4096 })),
    session_state: Type.Optional(Type.String({ maxLength: 512 })),
    iss: Type.Optional(Type.String({ maxLength: 512 })),
    authuser: Type.Optional(Type.String({ maxLength: 16 })),
    hd: Type.Optional(Type.String({ maxLength: 255 })),
    prompt: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);

function sanitizeReturnTo(value: string | undefined): string {
  return value !== undefined &&
    value.startsWith('/app') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    value.length <= 512
    ? value
    : '/app';
}

function loginRedirect(webOrigin: string, errorCode: string): string {
  const url = new URL('/login', webOrigin);
  url.searchParams.set('error', errorCode);
  return url.toString();
}

export function createSocialAuthRoutes(deps: SocialAuthRouteDependencies): RouteModule {
  const redirectUri = `${deps.publicApiOrigin.replace(/\/$/, '')}/v1/auth/google/callback`;

  return (app, services) => {
    app.get(
      '/v1/auth/google/start',
      { schema: { querystring: StartQuery } },
      async (request, reply) => {
        const returnTo = sanitizeReturnTo(request.query.return_to);
        const pkce = createPkcePair();
        const nonce = randomToken(32);
        const now = services.now();
        const state = signState(
          {
            v: sealVerifier(services.stateKey, pkce.verifier, SEAL_CONTEXT).toString('base64url'),
            n: sha256Hex(nonce),
            r: returnTo,
          },
          services.stateKey,
          STATE_TTL_SECONDS,
          now,
        );
        reply.setCookie(
          NONCE_COOKIE_NAME,
          nonce,
          NONCE_COOKIE_OPTIONS(services.environment, deps.cookieDomain),
        );
        const url = new URL(deps.google.endpoints.authorizeUrl);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', deps.google.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', LOGIN_SCOPES.join(' '));
        url.searchParams.set('state', state);
        url.searchParams.set('code_challenge', pkce.challenge);
        url.searchParams.set('code_challenge_method', 'S256');
        return reply.redirect(url.toString(), 302);
      },
    );

    app.get(
      '/v1/auth/google/callback',
      { schema: { querystring: CallbackQuery } },
      async (request, reply) => {
        const { state, code, error } = request.query;
        const clearNonceCookie = (): void => {
          reply.clearCookie(
            NONCE_COOKIE_NAME,
            NONCE_COOKIE_OPTIONS(services.environment, deps.cookieDomain),
          );
        };
        if (error !== undefined || state === undefined || code === undefined) {
          clearNonceCookie();
          return reply.redirect(loginRedirect(deps.webOrigin, 'google_failed'), 302);
        }
        const now = services.now();
        const payload = verifyState(state, services.stateKey, now);
        const sealedVerifier = payload?.['v'];
        const returnTo = payload?.['r'];
        const nonceHash = payload?.['n'];
        if (
          typeof sealedVerifier !== 'string' ||
          typeof returnTo !== 'string' ||
          typeof nonceHash !== 'string'
        ) {
          clearNonceCookie();
          return reply.redirect(loginRedirect(deps.webOrigin, 'google_expired'), 302);
        }
        const presentedNonce = request.cookies[NONCE_COOKIE_NAME];
        clearNonceCookie();
        if (presentedNonce === undefined) {
          return reply.redirect(loginRedirect(deps.webOrigin, 'google_expired'), 302);
        }
        const expectedHash = Buffer.from(nonceHash, 'utf8');
        const actualHash = Buffer.from(sha256Hex(presentedNonce), 'utf8');
        if (
          expectedHash.length !== actualHash.length ||
          !timingSafeEqual(expectedHash, actualHash)
        ) {
          return reply.redirect(loginRedirect(deps.webOrigin, 'google_expired'), 302);
        }
        const verifier = unsealVerifier(
          services.stateKey,
          Buffer.from(sealedVerifier, 'base64url'),
          SEAL_CONTEXT,
        );
        if (verifier === null) {
          return reply.redirect(loginRedirect(deps.webOrigin, 'google_expired'), 302);
        }
        try {
          const identity = await deps.tokenClient.exchangeIdentity({
            provider: 'google',
            code,
            codeVerifier: verifier,
            redirectUri,
          });
          const credential = await loginOrRegisterWithGoogle(services.db, identity.email);
          const session = await issueSession(services.db, deps.sessionSecret, credential, {
            userAgent: headerValue(request.headers['user-agent']) ?? null,
            ip: request.ip,
          });
          reply.setCookie(
            SESSION_COOKIE_NAME,
            session.token,
            cookieOptions(services.environment, SESSION_TTL_SECONDS, deps.cookieDomain),
          );
          return await reply.redirect(
            new URL(sanitizeReturnTo(returnTo), deps.webOrigin).toString(),
            302,
          );
        } catch (error_) {
          if (error_ instanceof OAuthExchangeError) {
            return reply.redirect(loginRedirect(deps.webOrigin, 'google_failed'), 302);
          }
          if (error_ instanceof ApiError) {
            const redirectErrorCode =
              error_.code === 'GOOGLE_ACCOUNT_HAS_PASSWORD'
                ? 'google_account_has_password'
                : 'google_failed';
            return reply.redirect(loginRedirect(deps.webOrigin, redirectErrorCode), 302);
          }
          throw error_;
        }
      },
    );
  };
}
