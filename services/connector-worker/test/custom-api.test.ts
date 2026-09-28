import { createHmac } from 'node:crypto';
import { TenantSecretError, type TenantSecretReader } from '@velyric/tenant-secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolExecutionError } from '../src/errors.js';
import {
  CustomApiExecutor,
  buildCustomApiRequest,
  signCustomApiRequest,
  type CustomApiDefinition,
} from '../src/tools/custom-api.js';
import { loopbackResolver, startFakeProvider, type FakeProvider } from './support/http.js';

const HOST = 'api.partner.test';
const BEARER_REF = 'aws-sm://tenants/t/custom-api-credential/bearer/v1';
const HMAC_REF = 'aws-sm://tenants/t/custom-api-credential/hmac/v1';
let provider: FakeProvider;

const secrets: TenantSecretReader = {
  read: (reference) => {
    if (reference === BEARER_REF) {
      return Promise.resolve('partner-token');
    }
    if (reference === HMAC_REF) {
      return Promise.resolve('hmac-secret');
    }
    return Promise.reject(new TenantSecretError('SECRET_UNAVAILABLE', 'missing'));
  },
};

beforeAll(async () => {
  provider = await startFakeProvider();
});

afterAll(async () => {
  await provider.close();
});

function definition(overrides: Partial<CustomApiDefinition> = {}): CustomApiDefinition {
  return {
    id: '0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e5f',
    name: 'create_ticket',
    baseUrl: `http://${HOST}:${String(provider.port)}`,
    pathTemplate: '/v1/customers/{customer_id}/tickets',
    httpMethod: 'POST',
    allowedHosts: [HOST],
    authType: 'BEARER',
    authSecretRef: BEARER_REF,
    responseMaxBytes: 65_536,
    maxRetries: 2,
    idempotencySupported: true,
    timeoutMs: 3_000,
    ...overrides,
  };
}

function executor(now: () => number = Date.now): CustomApiExecutor {
  return new CustomApiExecutor({
    secrets,
    environment: 'ci',
    allowHttp: true,
    resolver: loopbackResolver,
    sleep: () => Promise.resolve(),
    now,
  });
}

async function failure(promise: Promise<unknown>): Promise<ToolExecutionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a failure');
}

const invocation = {
  toolRunId: '0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e60',
  idempotencyKey: 'call:tool-run-0001',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
};

describe('custom API request building', () => {
  it('fills path parameters and routes remaining arguments to the body or query string', () => {
    expect(
      buildCustomApiRequest(definition({ baseUrl: 'https://api.partner.test' }), {
        customer_id: 'c 1',
        subject: 'Időpont',
      }),
    ).toEqual({
      url: 'https://api.partner.test/v1/customers/c%201/tickets',
      method: 'POST',
      body: '{"subject":"Időpont"}',
    });
    expect(
      buildCustomApiRequest(
        definition({
          baseUrl: 'https://api.partner.test',
          pathTemplate: '/v1/orders/{order_id}',
          httpMethod: 'GET',
        }),
        { order_id: 'o1', expand: true, limit: 5 },
      ),
    ).toEqual({
      url: 'https://api.partner.test/v1/orders/o1?expand=true&limit=5',
      method: 'GET',
      body: undefined,
    });
  });

  it('rejects missing parameters, nested query values and unsupported methods', async () => {
    expect(
      (
        await failure(
          Promise.resolve().then(() => buildCustomApiRequest(definition(), { subject: 'x' })),
        )
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          Promise.resolve().then(() =>
            buildCustomApiRequest(definition({ httpMethod: 'GET', pathTemplate: '/v1/items' }), {
              filter: { a: 1 },
            }),
          ),
        )
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          Promise.resolve().then(() =>
            buildCustomApiRequest(definition({ httpMethod: 'TRACE' }), { customer_id: 'c1' }),
          ),
        )
      ).code,
    ).toBe('TOOL_NOT_ALLOWED');
    expect(signCustomApiRequest('secret', 1_700_000_000, '{}')).toBe(
      createHmac('sha256', 'secret').update('1700000000.{}').digest('hex'),
    );
  });
});

describe('custom API execution', () => {
  it('authenticates, sends the idempotency key and retries transient failures', async () => {
    provider.requests.length = 0;
    let calls = 0;
    provider.route((request) => {
      if (!request.path.startsWith('/v1/customers/c1/tickets')) {
        return undefined;
      }
      calls += 1;
      return calls === 1
        ? { status: 503, body: { error: 'busy' } }
        : { status: 201, body: { ticket_id: 'T-1' } };
    });
    const outcome = await executor().execute(definition(), {
      ...invocation,
      arguments: { customer_id: 'c1', subject: 'Visszahívás' },
    });
    expect(outcome).toEqual({ result: { ticket_id: 'T-1' }, httpStatus: 201 });
    expect(provider.requests).toHaveLength(2);
    const last = provider.requests[1];
    expect(last?.headers['authorization']).toBe('Bearer partner-token');
    expect(last?.headers['idempotency-key']).toBe('call:tool-run-0001');
    expect(last?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(last?.body ?? '{}')).toEqual({ subject: 'Visszahívás' });
  });

  it('does not retry client errors or non-idempotent writes', async () => {
    provider.requests.length = 0;
    provider.route((request) =>
      request.path.startsWith('/v1/customers/c2/')
        ? { status: 422, body: { error: 'invalid' } }
        : undefined,
    );
    const rejected = await failure(
      executor().execute(definition(), { ...invocation, arguments: { customer_id: 'c2' } }),
    );
    expect([rejected.code, rejected.httpStatus, rejected.retryable]).toEqual([
      'PROVIDER_ERROR',
      422,
      false,
    ]);
    provider.route((request) =>
      request.path.startsWith('/v1/customers/c3/') ? { status: 503 } : undefined,
    );
    const unavailable = await failure(
      executor().execute(definition({ idempotencySupported: false }), {
        ...invocation,
        arguments: { customer_id: 'c3' },
      }),
    );
    expect([unavailable.code, unavailable.retryable]).toEqual(['PROVIDER_UNAVAILABLE', true]);
    expect(provider.requests).toHaveLength(2);
  });

  it('signs HMAC requests and enforces the egress allowlist', async () => {
    provider.requests.length = 0;
    provider.route((request) =>
      request.path.startsWith('/v1/customers/c4/') ? { status: 200, body: [1, 2] } : undefined,
    );
    const outcome = await executor(() => 1_700_000_000_000).execute(
      definition({ authType: 'HMAC', authSecretRef: HMAC_REF }),
      {
        ...invocation,
        arguments: { customer_id: 'c4', note: 'x' },
      },
    );
    expect(outcome.result).toEqual({ data: [1, 2] });
    const request = provider.requests[0];
    expect(request?.headers['x-velyric-timestamp']).toBe('1700000000');
    expect(request?.headers['x-velyric-signature']).toBe(
      `v1=${signCustomApiRequest('hmac-secret', 1_700_000_000, '{"note":"x"}')}`,
    );
    const blocked = await failure(
      executor().execute(definition({ allowedHosts: ['other.partner.test'] }), {
        ...invocation,
        arguments: { customer_id: 'c5' },
      }),
    );
    expect(blocked.code).toBe('EGRESS_BLOCKED');
    const noHttp = new CustomApiExecutor({
      secrets,
      environment: 'ci',
      allowHttp: false,
      resolver: loopbackResolver,
    });
    expect(
      (
        await failure(
          noHttp.execute(definition(), { ...invocation, arguments: { customer_id: 'c6' } }),
        )
      ).code,
    ).toBe('EGRESS_BLOCKED');
  });
});
