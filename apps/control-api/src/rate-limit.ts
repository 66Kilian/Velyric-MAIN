import type { Principal } from './principal.js';

export interface RateLimitPolicy {
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetSeconds: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}

export interface RateLimitSubject {
  readonly method: string;
  readonly route: string | undefined;
  readonly ip: string;
  readonly principal: Principal | null;
}

export interface RateLimitTarget {
  readonly key: string;
  readonly policy: RateLimitPolicy;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const RATE_LIMIT_POLICIES = Object.freeze({
  anonymous: { name: 'anonymous', limit: 120, windowSeconds: 60 },
  providerWebhook: { name: 'provider-webhook', limit: 3_000, windowSeconds: 60 },
  userRead: { name: 'user-read', limit: 1_200, windowSeconds: 60 },
  userWrite: { name: 'user-write', limit: 240, windowSeconds: 60 },
  apiKeyRead: { name: 'api-key-read', limit: 600, windowSeconds: 60 },
  apiKeyWrite: { name: 'api-key-write', limit: 120, windowSeconds: 60 },
  service: { name: 'service', limit: 6_000, windowSeconds: 60 },
} satisfies Record<string, RateLimitPolicy>);

const SENSITIVE_ROUTES: ReadonlyMap<string, RateLimitPolicy> = new Map([
  ['POST /v1/workspaces', { name: 'workspace-create', limit: 10, windowSeconds: 3_600 }],
  ['POST /v1/members/invitations', { name: 'member-invite', limit: 50, windowSeconds: 3_600 }],
  ['POST /v1/api-keys', { name: 'api-key-create', limit: 20, windowSeconds: 3_600 }],
  ['POST /v1/billing/checkout', { name: 'checkout', limit: 20, windowSeconds: 600 }],
  [
    'POST /v1/phone-orders/:id/kyc-submissions',
    { name: 'kyc-submit', limit: 12, windowSeconds: 3_600 },
  ],
  [
    'POST /v1/knowledge-sources/:id/uploads',
    { name: 'knowledge-upload', limit: 240, windowSeconds: 3_600 },
  ],
  [
    'POST /v1/integrations/oauth/authorizations',
    { name: 'oauth-authorize', limit: 60, windowSeconds: 600 },
  ],
  ['POST /v1/calls/:id/transfer', { name: 'call-control', limit: 120, windowSeconds: 60 }],
  ['POST /v1/calls/:id/terminate', { name: 'call-control', limit: 120, windowSeconds: 60 }],
]);

function tenantOf(principal: Principal): string {
  if (principal.kind === 'api_key') {
    return principal.tenantId;
  }
  if (principal.kind === 'user') {
    return principal.membership?.tenantId ?? 'none';
  }
  return principal.tenantId ?? 'none';
}

function actorOf(principal: Principal): string {
  switch (principal.kind) {
    case 'user':
      return `user:${principal.userId}`;
    case 'api_key':
      return `key:${principal.apiKeyId}`;
    case 'service':
      return `svc:${principal.issuer}`;
  }
}

export function rateLimitTargets(subject: RateLimitSubject): RateLimitTarget[] {
  const read = READ_METHODS.has(subject.method);
  const routeKey = subject.route === undefined ? undefined : `${subject.method} ${subject.route}`;
  if (subject.route !== undefined && subject.route.startsWith('/v1/webhooks/providers/')) {
    return [
      {
        key: `ip:${subject.ip}:${RATE_LIMIT_POLICIES.providerWebhook.name}`,
        policy: RATE_LIMIT_POLICIES.providerWebhook,
      },
    ];
  }
  const principal = subject.principal;
  if (principal === null) {
    return [
      {
        key: `ip:${subject.ip}:${RATE_LIMIT_POLICIES.anonymous.name}`,
        policy: RATE_LIMIT_POLICIES.anonymous,
      },
    ];
  }
  const actor = actorOf(principal);
  const general =
    principal.kind === 'service'
      ? RATE_LIMIT_POLICIES.service
      : principal.kind === 'api_key'
        ? read
          ? RATE_LIMIT_POLICIES.apiKeyRead
          : RATE_LIMIT_POLICIES.apiKeyWrite
        : read
          ? RATE_LIMIT_POLICIES.userRead
          : RATE_LIMIT_POLICIES.userWrite;
  const targets: RateLimitTarget[] = [{ key: `${actor}:${general.name}`, policy: general }];
  const sensitive = routeKey === undefined ? undefined : SENSITIVE_ROUTES.get(routeKey);
  if (sensitive !== undefined) {
    targets.push({
      key: `tenant:${tenantOf(principal)}:${actor}:${sensitive.name}`,
      policy: sensitive,
    });
  }
  return targets;
}

export interface GcraState {
  readonly theoreticalArrivalMs: number;
}

export function gcra(
  previous: GcraState | null,
  nowMs: number,
  policy: RateLimitPolicy,
): { readonly decision: RateLimitDecision; readonly next: GcraState | null } {
  const periodMs = policy.windowSeconds * 1000;
  const intervalMs = periodMs / policy.limit;
  const tat = Math.max(previous?.theoreticalArrivalMs ?? nowMs, nowMs);
  const nextTat = tat + intervalMs;
  const allowAt = nextTat - periodMs;
  if (allowAt > nowMs) {
    return {
      decision: {
        allowed: false,
        remaining: 0,
        resetSeconds: Math.ceil((tat - nowMs) / 1000),
        retryAfterSeconds: Math.max(1, Math.ceil((allowAt - nowMs) / 1000)),
      },
      next: null,
    };
  }
  const remaining = Math.max(0, Math.floor((nowMs - allowAt) / intervalMs));
  return {
    decision: {
      allowed: true,
      remaining,
      resetSeconds: Math.ceil((nextTat - nowMs) / 1000),
      retryAfterSeconds: 0,
    },
    next: { theoreticalArrivalMs: nextTat },
  };
}

const GCRA_SCRIPT = `
local period_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local interval = period_ms / limit
local stored = redis.call('GET', KEYS[1])
local tat = now
if stored then
  tat = math.max(tonumber(stored), now)
end
local next_tat = tat + interval
local allow_at = next_tat - period_ms
if allow_at > now then
  return {0, 0, math.ceil((tat - now) / 1000), math.max(1, math.ceil((allow_at - now) / 1000))}
end
redis.call('SET', KEYS[1], string.format('%.3f', next_tat), 'PX', math.ceil(next_tat - now))
return {1, math.max(0, math.floor((now - allow_at) / interval)), math.ceil((next_tat - now) / 1000), 0}
`;

export interface RedisScriptClient {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: RedisScriptClient;
  private readonly namespace: string;

  constructor(redis: RedisScriptClient, namespace: string) {
    this.redis = redis;
    this.namespace = namespace;
  }

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const result = await this.redis.eval(
      GCRA_SCRIPT,
      1,
      `${this.namespace}:rl:${key}`,
      policy.windowSeconds * 1000,
      policy.limit,
    );
    if (!Array.isArray(result) || result.length < 4) {
      throw new Error('unexpected rate limiter response');
    }
    return {
      allowed: toNumber(result[0]) === 1,
      remaining: toNumber(result[1]),
      resetSeconds: toNumber(result[2]),
      retryAfterSeconds: toNumber(result[3]),
    };
  }
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly state = new Map<string, GcraState>();

  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const stateKey = `${policy.name}:${key}`;
    const { decision, next } = gcra(this.state.get(stateKey) ?? null, this.clock(), policy);
    if (next !== null) {
      this.state.set(stateKey, next);
    }
    return Promise.resolve(decision);
  }
}

export function rateLimitHeaders(
  policy: RateLimitPolicy,
  decision: RateLimitDecision,
): Record<string, string> {
  return {
    'ratelimit-policy': `"${policy.name}";q=${String(policy.limit)};w=${String(policy.windowSeconds)}`,
    ratelimit: `"${policy.name}";r=${String(decision.remaining)};t=${String(decision.resetSeconds)}`,
  };
}
