import { describe, expect, it } from 'vitest';
import type { Principal } from '../src/principal.js';
import {
  gcra,
  InMemoryRateLimiter,
  RATE_LIMIT_POLICIES,
  rateLimitHeaders,
  rateLimitTargets,
  RedisRateLimiter,
  type GcraState,
  type RateLimitPolicy,
} from '../src/rate-limit.js';

const policy: RateLimitPolicy = { name: 'test', limit: 3, windowSeconds: 60 };

const user: Principal = {
  kind: 'user',
  userId: 'u1',
  authSubject: 'user_01',
  email: 'owner@example.test',
  sessionId: 's1',
  platformRole: null,
  membership: { tenantId: 't1', role: 'OWNER', locationScope: [] },
};

describe('gcra', () => {
  it('allows a burst up to the limit and then rejects with retry-after', () => {
    let state: GcraState | null = null;
    const now = 1_000_000;
    const remaining: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = gcra(state, now, policy);
      expect(result.decision.allowed).toBe(true);
      remaining.push(result.decision.remaining);
      state = result.next;
    }
    expect(remaining).toEqual([2, 1, 0]);
    const rejected = gcra(state, now, policy);
    expect(rejected.decision).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 20,
    });
    expect(rejected.next).toBeNull();
  });

  it('replenishes one request per emission interval', () => {
    let state: GcraState | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      state = gcra(state, 0, policy).next;
    }
    expect(gcra(state, 19_999, policy).decision.allowed).toBe(false);
    const later = gcra(state, 20_000, policy);
    expect(later.decision).toMatchObject({ allowed: true, remaining: 0 });
  });
});

describe('rate limit targets', () => {
  it('limits anonymous traffic by client address', () => {
    expect(
      rateLimitTargets({ method: 'GET', route: '/v1/me', ip: '203.0.113.9', principal: null }),
    ).toEqual([{ key: 'ip:203.0.113.9:anonymous', policy: RATE_LIMIT_POLICIES.anonymous }]);
  });

  it('uses the provider webhook policy for signed provider callbacks', () => {
    const [target] = rateLimitTargets({
      method: 'POST',
      route: '/v1/webhooks/providers/stripe',
      ip: '198.51.100.1',
      principal: null,
    });
    expect(target?.policy).toBe(RATE_LIMIT_POLICIES.providerWebhook);
  });

  it('separates read and write budgets and adds tenant scoped sensitive route budgets', () => {
    expect(
      rateLimitTargets({ method: 'GET', route: '/v1/calls', ip: '::1', principal: user }).map(
        (target) => target.key,
      ),
    ).toEqual(['user:u1:user-read']);
    expect(
      rateLimitTargets({ method: 'POST', route: '/v1/api-keys', ip: '::1', principal: user }).map(
        (target) => target.key,
      ),
    ).toEqual(['user:u1:user-write', 'tenant:t1:user:u1:api-key-create']);
    const apiKey: Principal = {
      kind: 'api_key',
      apiKeyId: 'k1',
      tenantId: 't2',
      scopes: new Set(),
    };
    expect(
      rateLimitTargets({
        method: 'PATCH',
        route: '/v1/agents/:id',
        ip: '::1',
        principal: apiKey,
      })[0]?.policy,
    ).toBe(RATE_LIMIT_POLICIES.apiKeyWrite);
  });

  it('formats structured rate limit headers', () => {
    expect(
      rateLimitHeaders(policy, {
        allowed: true,
        remaining: 2,
        resetSeconds: 20,
        retryAfterSeconds: 0,
      }),
    ).toEqual({
      'ratelimit-policy': '"test";q=3;w=60',
      ratelimit: '"test";r=2;t=20',
    });
  });
});

describe('limiters', () => {
  it('keeps independent in-memory buckets per key', async () => {
    let now = 0;
    const limiter = new InMemoryRateLimiter(() => now);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await limiter.consume('a', policy)).allowed).toBe(true);
    }
    expect((await limiter.consume('a', policy)).allowed).toBe(false);
    expect((await limiter.consume('b', policy)).allowed).toBe(true);
    now = 60_000;
    expect((await limiter.consume('a', policy)).allowed).toBe(true);
  });

  it('maps the redis script reply and namespaces keys', async () => {
    const calls: unknown[][] = [];
    const limiter = new RedisRateLimiter(
      {
        eval: (script, keys, ...args) => {
          calls.push([script.includes('TIME'), keys, ...args]);
          return Promise.resolve([0, 0, 12, 7]);
        },
      },
      'vly:ci',
    );
    await expect(limiter.consume('user:u1:user-write', policy)).resolves.toEqual({
      allowed: false,
      remaining: 0,
      resetSeconds: 12,
      retryAfterSeconds: 7,
    });
    expect(calls).toEqual([[true, 1, 'vly:ci:rl:user:u1:user-write', 60_000, 3]]);
  });

  it('rejects malformed redis replies', async () => {
    const limiter = new RedisRateLimiter({ eval: () => Promise.resolve('OK') }, 'vly:ci');
    await expect(limiter.consume('k', policy)).rejects.toThrow('unexpected rate limiter response');
  });
});
