import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import underPressure from '@fastify/under-pressure';
import type { VelyricEnvironment } from '@velyric/contracts';
import { withTenantTransaction, type DB, type TenantContext } from '@velyric/db';
import { csrfTokensMatch } from '@velyric/security';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RawServerDefault,
} from 'fastify';
import type { Kysely } from 'kysely';
import {
  SESSION_COOKIE_NAME,
  WORKSPACE_HEADER,
  type PublicAuthenticator,
  type ServiceAuthenticator,
} from './auth.js';
import { ApiError, toApiError } from './errors.js';
import {
  beginIdempotent,
  completeIdempotent,
  requestFingerprint,
  requireIdempotencyKey,
  type RequestMeta,
  type Trx,
} from './persistence.js';
import type { Principal, TenantActor } from './principal.js';
import {
  rateLimitHeaders,
  rateLimitTargets,
  type RateLimitDecision,
  type RateLimiter,
} from './rate-limit.js';

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
    principal: Principal | null;
    rawBody: string | null;
  }
}

export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

export interface AppServices {
  readonly environment: VelyricEnvironment;
  readonly db: Kysely<DB>;
  readonly cursorKey: Uint8Array;
  readonly stateKey: Uint8Array;
  readonly now: () => Date;
}

export type RouteModule = (app: AppInstance, services: AppServices) => void;

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function csrfCookieName(environment: VelyricEnvironment): string {
  return environment === 'local' || environment === 'ci' ? 'vly_csrf' : '__Host-vly_csrf';
}

function resolveTraceId(traceparent: string | undefined): string {
  const match = traceparent === undefined ? null : TRACEPARENT_PATTERN.exec(traceparent);
  const candidate = match?.[1];
  return candidate !== undefined && !/^0+$/.test(candidate)
    ? candidate
    : randomBytes(16).toString('hex');
}

export function requestMeta(request: FastifyRequest): RequestMeta {
  return {
    traceId: request.traceId,
    ip: request.ip === '' ? null : request.ip,
    userAgent: headerValue(request.headers['user-agent']) ?? null,
  };
}

function validationIssues(error: FastifyError): { path: string; rule: string }[] {
  const context = error.validationContext ?? 'body';
  return (error.validation ?? []).slice(0, 25).map((issue) => ({
    path: `/${context}${issue.instancePath}`,
    rule: issue.keyword,
  }));
}

function mapFrameworkError(error: FastifyError): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error.validation !== undefined) {
    return new ApiError('VALIDATION_FAILED', { issues: validationIssues(error) });
  }
  switch (error.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new ApiError('PAYLOAD_TOO_LARGE');
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new ApiError('UNSUPPORTED_MEDIA_TYPE');
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return new ApiError('MALFORMED_REQUEST');
    default:
      return toApiError(error);
  }
}

function sendError(request: FastifyRequest, reply: FastifyReply, error: ApiError): FastifyReply {
  return reply
    .code(error.statusCode)
    .headers({ ...error.headers, 'x-trace-id': request.traceId })
    .send(error.toEnvelope(request.traceId));
}

function createBaseApp(environment: VelyricEnvironment, logger: boolean): AppInstance {
  const app = Fastify({
    logger: logger
      ? {
          level: 'info',
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-csrf-token"]',
          ],
        }
      : false,
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
    return503OnClosing: true,
    trustProxy: environment === 'staging' || environment === 'production',
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setValidatorCompiler(TypeBoxValidatorCompiler);
  app.decorateRequest('traceId', '');
  app.decorateRequest('principal', null);
  app.decorateRequest('rawBody', null);

  app.addHook('onRequest', (request, reply, done) => {
    request.traceId = resolveTraceId(headerValue(request.headers['traceparent']));
    reply.header('x-trace-id', request.traceId);
    done();
  });

  app.removeContentTypeParser(['application/json']);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = text;
    if (text.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      done(new ApiError('MALFORMED_REQUEST'), undefined);
    }
  });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (request, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      request.rawBody = text;
      done(null, Object.fromEntries(new URLSearchParams(text)));
    },
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const apiError = mapFrameworkError(error);
    if (apiError.statusCode >= 500) {
      request.log.error({ err: error, trace_id: request.traceId }, 'request failed');
    }
    return sendError(request, reply, apiError);
  });
  app.setNotFoundHandler((request, reply) => sendError(request, reply, new ApiError('NOT_FOUND')));
  return app;
}

export interface PublicAppOptions {
  readonly services: AppServices;
  readonly authenticator: PublicAuthenticator;
  readonly corsAllowedOrigins: readonly string[];
  readonly modules: readonly RouteModule[];
  readonly logger?: boolean;
  readonly rateLimiter?: RateLimiter;
}

export async function buildPublicApp(options: PublicAppOptions): Promise<AppInstance> {
  const { services } = options;
  const app = createBaseApp(services.environment, options.logger ?? false);
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, origin === undefined || options.corsAllowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'if-match',
      'x-csrf-token',
      WORKSPACE_HEADER,
      'traceparent',
    ],
    exposedHeaders: [
      'x-trace-id',
      'etag',
      'idempotency-replayed',
      'retry-after',
      'ratelimit',
      'ratelimit-policy',
    ],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(underPressure, {
    maxEventLoopDelay: 1_000,
    retryAfter: 5,
    pressureHandler: (request, reply) => {
      void sendError(
        request,
        reply,
        new ApiError('SERVICE_UNAVAILABLE', undefined, { headers: { 'retry-after': '5' } }),
      );
    },
  });

  const csrfCookie = csrfCookieName(services.environment);
  const limiter = options.rateLimiter;
  const enforceRateLimit = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (limiter === undefined) {
      return;
    }
    const targets = rateLimitTargets({
      method: request.method,
      route: request.routeOptions.url,
      ip: request.ip,
      principal: request.principal,
    });
    let headers: Record<string, string> | null = null;
    for (const target of targets) {
      let decision: RateLimitDecision;
      try {
        decision = await limiter.consume(target.key, target.policy);
      } catch (error) {
        request.log.warn({ err: error, policy: target.policy.name }, 'rate limiter unavailable');
        return;
      }
      const current = rateLimitHeaders(target.policy, decision);
      if (!decision.allowed) {
        throw new ApiError(
          'RATE_LIMITED',
          { policy: target.policy.name },
          { headers: { ...current, 'retry-after': String(decision.retryAfterSeconds) } },
        );
      }
      if (headers === null || target !== targets[0]) {
        headers = current;
      }
    }
    if (headers !== null) {
      void reply.headers(headers);
    }
  };
  app.addHook('preValidation', async (request, reply) => {
    if (request.url.startsWith('/v1/webhooks/')) {
      request.principal = null;
      await enforceRateLimit(request, reply);
      return;
    }
    const authorization = headerValue(request.headers.authorization);
    const sessionCookie = request.cookies[SESSION_COOKIE_NAME];
    if (
      STATE_CHANGING_METHODS.has(request.method) &&
      authorization === undefined &&
      sessionCookie !== undefined
    ) {
      const origin = headerValue(request.headers.origin);
      const tokensMatch = csrfTokensMatch(
        request.cookies[csrfCookie],
        headerValue(request.headers['x-csrf-token']),
      );
      if (origin === undefined || !options.corsAllowedOrigins.includes(origin) || !tokensMatch) {
        throw new ApiError('CSRF_TOKEN_INVALID');
      }
    }
    request.principal = await options.authenticator.authenticate({
      authorization,
      sessionCookie,
      workspace: headerValue(request.headers[WORKSPACE_HEADER]),
      traceId: request.traceId,
    });
    await enforceRateLimit(request, reply);
  });

  for (const register of options.modules) {
    register(app, services);
  }
  return app;
}

export interface InternalAppOptions {
  readonly services: AppServices;
  readonly authenticator: ServiceAuthenticator;
  readonly modules: readonly RouteModule[];
  readonly jwks: string;
  readonly readiness: () => Promise<boolean>;
  readonly logger?: boolean;
}

export function buildInternalApp(options: InternalAppOptions): AppInstance {
  const app = createBaseApp(options.services.environment, options.logger ?? false);
  app.get('/healthz/live', () => ({ status: 'ok' }));
  app.get('/healthz/ready', async (_request, reply) => {
    const ready = await options.readiness().catch(() => false);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });
  app.get('/internal/v1/.well-known/jwks.json', (_request, reply) =>
    reply
      .header('cache-control', 'public, max-age=600')
      .type('application/json')
      .send(options.jwks),
  );
  app.addHook('preValidation', async (request) => {
    if (
      request.url.startsWith('/internal/v1/') &&
      !request.url.startsWith('/internal/v1/.well-known/')
    ) {
      request.principal = await options.authenticator.authenticate(
        headerValue(request.headers.authorization),
      );
    }
  });
  for (const register of options.modules) {
    register(app, options.services);
  }
  return app;
}

export function tenantContext(actor: TenantActor, request: FastifyRequest): TenantContext {
  return {
    tenantId: actor.tenantId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    traceId: request.traceId,
    ...(actor.userId === undefined ? {} : { userId: actor.userId }),
  };
}

export function inTenant<T>(
  services: AppServices,
  actor: TenantActor,
  request: FastifyRequest,
  fn: (trx: Trx) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(services.db, tenantContext(actor, request), fn);
}

export interface WriteResult<T> {
  readonly status: number;
  readonly body: T;
  readonly resource?: { readonly type: string; readonly id: string };
  readonly headers?: Readonly<Record<string, string>>;
  readonly storedBody?: unknown;
}

export async function idempotentWrite<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  services: AppServices,
  context: TenantContext,
  owner: { readonly tenantId: string | null; readonly userId: string | null },
  scope: string,
  fn: (trx: Trx) => Promise<WriteResult<T>>,
): Promise<FastifyReply> {
  const key = requireIdempotencyKey(request.headers['idempotency-key']);
  const fingerprint = requestFingerprint(request.method, request.routeOptions.url ?? request.url, {
    params: request.params,
    body: request.body,
  });
  const outcome = await withTenantTransaction(services.db, context, async (trx) => {
    const start = await beginIdempotent(trx, { ...owner, scope, key, fingerprint });
    if (start.kind === 'replay') {
      return { replayed: true, status: start.status, body: start.body, headers: {} };
    }
    const result = await fn(trx);
    await completeIdempotent(
      trx,
      start.recordId,
      result.status,
      result.storedBody === undefined ? result.body : result.storedBody,
      result.resource,
    );
    return {
      replayed: false,
      status: result.status,
      body: result.body as unknown,
      headers: result.headers ?? {},
    };
  });
  reply.code(outcome.status).headers(outcome.headers);
  if (outcome.replayed) {
    reply.header('idempotency-replayed', 'true');
  }
  return reply.send(outcome.body);
}

export function requireIfMatch(request: FastifyRequest): number {
  const raw = headerValue(request.headers['if-match']);
  if (raw === undefined) {
    throw new ApiError('PRECONDITION_REQUIRED');
  }
  const match = /^(?:W\/)?"([1-9][0-9]{0,8})"$/.exec(raw.trim());
  if (match?.[1] === undefined) {
    throw new ApiError('VALIDATION_FAILED', {
      issues: [{ path: '/headers/if-match', rule: 'etag' }],
    });
  }
  return Number(match[1]);
}

export function weakEtag(version: number): string {
  return `W/"${String(version)}"`;
}

export async function assertKillSwitchReleased(
  trx: Trx,
  switchKey: string,
  scopes: readonly { readonly scopeType: string; readonly scopeRef: string }[],
): Promise<void> {
  const engaged = await trx
    .selectFrom('kill_switches')
    .select(['switch_key', 'scope_type', 'scope_ref'])
    .where('switch_key', '=', switchKey)
    .where('engaged', '=', true)
    .where((eb) =>
      eb.or([
        eb('scope_type', '=', 'GLOBAL'),
        ...scopes.map((scope) =>
          eb.and([eb('scope_type', '=', scope.scopeType), eb('scope_ref', '=', scope.scopeRef)]),
        ),
      ]),
    )
    .executeTakeFirst();
  if (engaged !== undefined) {
    throw new ApiError('KILL_SWITCH_ACTIVE', {
      switch_key: switchKey,
      scope_type: engaged.scope_type,
    });
  }
}
