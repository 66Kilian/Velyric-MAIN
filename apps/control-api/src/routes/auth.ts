import Type from 'typebox';
import { headerValue, requestMeta, type RouteModule } from '../app.js';
import {
  CredentialAuthenticator,
  issueSession,
  revokeSession,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from '../auth.js';
import { ApiError } from '../errors.js';
import type { TurnstileVerifier } from '../turnstile.js';

export interface AuthRouteDependencies {
  readonly sessionSecret: string;
  readonly cookieDomain: string | null;
  readonly turnstile: TurnstileVerifier;
}

const RegisterBody = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 320 }),
  password: Type.String({ minLength: 1, maxLength: 256 }),
  // Required only while deps.turnstile.enabled is true (a secret is configured).
  turnstile_token: Type.Optional(Type.String({ minLength: 10, maxLength: 4096 })),
});

const LoginBody = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 320 }),
  password: Type.String({ minLength: 1, maxLength: 256 }),
});

export function cookieOptions(
  environment: string,
  maxAgeSeconds: number,
  cookieDomain: string | null,
): {
  readonly path: string;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly maxAge: number;
  readonly domain?: string;
} {
  return {
    path: '/',
    httpOnly: true,
    secure: environment === 'staging' || environment === 'production',
    sameSite: 'lax',
    maxAge: maxAgeSeconds,
    ...(cookieDomain === null ? {} : { domain: cookieDomain }),
  };
}

export function createAuthRoutes(deps: AuthRouteDependencies): RouteModule {
  return (app, services) => {
    const credentials = new CredentialAuthenticator(services.db);

    app.post('/v1/auth/register', { schema: { body: RegisterBody } }, async (request, reply) => {
      if (deps.turnstile.enabled) {
        const token = request.body.turnstile_token;
        const verified =
          token !== undefined && (await deps.turnstile.verify(token, requestMeta(request).ip));
        if (!verified) {
          throw new ApiError('TURNSTILE_VERIFICATION_FAILED');
        }
      }
      const credential = await credentials.register(request.body.email, request.body.password);
      const session = await issueSession(services.db, deps.sessionSecret, credential, {
        userAgent: headerValue(request.headers['user-agent']) ?? null,
        ip: request.ip,
      });
      reply.setCookie(
        SESSION_COOKIE_NAME,
        session.token,
        cookieOptions(services.environment, SESSION_TTL_SECONDS, deps.cookieDomain),
      );
      return reply.code(201).send({ email: credential.email });
    });

    app.post('/v1/auth/login', { schema: { body: LoginBody } }, async (request, reply) => {
      const credential = await credentials.authenticate(request.body.email, request.body.password);
      const session = await issueSession(services.db, deps.sessionSecret, credential, {
        userAgent: headerValue(request.headers['user-agent']) ?? null,
        ip: request.ip,
      });
      reply.setCookie(
        SESSION_COOKIE_NAME,
        session.token,
        cookieOptions(services.environment, SESSION_TTL_SECONDS, deps.cookieDomain),
      );
      return reply.code(200).send({ email: credential.email });
    });

    app.post('/v1/auth/logout', async (request, reply) => {
      if (request.principal?.kind === 'user') {
        await revokeSession(services.db, request.principal.sessionId);
      }
      reply.clearCookie(SESSION_COOKIE_NAME, {
        path: '/',
        ...(deps.cookieDomain === null ? {} : { domain: deps.cookieDomain }),
      });
      return reply.code(204).send();
    });
  };
}
