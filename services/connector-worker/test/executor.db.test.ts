import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  importServiceSigner,
  signServiceToken,
  type ServiceScope,
  type ServiceSigner,
} from '@velyric/security';
import { exportJWK, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executeMessage,
  type ExecutorDependencies,
  type IncomingExecuteMessage,
} from '../src/executor.js';
import { CustomApiExecutor } from '../src/tools/custom-api.js';
import { seedBookableLocation, useTestDatabase } from './support/db.js';
import { loopbackResolver, startFakeProvider, type FakeProvider } from './support/http.js';

const database = useTestDatabase();
const HOST = 'tickets.partner.test';
let provider: FakeProvider;
let controlApi: ServiceSigner;
let voiceRuntime: ServiceSigner;
let jwks: JSONWebKeySet;
const usedTokens = new Set<string>();

beforeAll(async () => {
  provider = await startFakeProvider();
  const keys = await Promise.all(
    (['control-api', 'voice-runtime'] as const).map(async (issuer) => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const signer = await importServiceSigner(
        issuer,
        `${issuer}-test`,
        privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      );
      return {
        signer,
        jwk: { ...(await exportJWK(publicKey)), kid: `${issuer}-test`, alg: 'EdDSA', use: 'sig' },
      };
    }),
  );
  const [control, runtime] = keys;
  if (control === undefined || runtime === undefined) {
    throw new Error('signing keys were not generated');
  }
  controlApi = control.signer;
  voiceRuntime = runtime.signer;
  jwks = { keys: keys.map((key) => key.jwk) };
});

afterAll(async () => {
  await provider.close();
});

function deps(): ExecutorDependencies {
  return {
    db: database().db,
    verifier: {
      audience: 'connector-worker',
      jwks,
      replayGuard: (issuer, jti) => {
        const key = `${issuer}:${jti}`;
        if (usedTokens.has(key)) {
          return Promise.resolve(false);
        }
        usedTokens.add(key);
        return Promise.resolve(true);
      },
    },
    calendars: {},
    customApi: new CustomApiExecutor({
      secrets: { read: () => Promise.reject(new Error('unused')) },
      environment: 'ci',
      allowHttp: true,
      resolver: loopbackResolver,
    }),
    now: () => new Date('2030-01-07T00:00:00Z'),
    logger: { warn: () => undefined, error: () => undefined },
  };
}

interface SeededTools {
  readonly tenantId: string;
  readonly serviceId: string;
  readonly availabilityToolId: string;
  readonly ticketToolId: string;
  readonly disabledToolId: string;
}

async function seedTools(): Promise<SeededTools> {
  const seeded = await seedBookableLocation(database().admin);
  const insert = async (values: unknown[], sql: string): Promise<string> => {
    const result = await database().admin.query<{ id: string }>(sql, values);
    return result.rows[0]?.id ?? '';
  };
  const base = `INSERT INTO app.tool_definitions (tenant_id, name, description, kind, connector_key, input_schema, output_schema, side_effect_class, confirmation_policy, base_url, http_method, path_template, allowed_hosts, status, timeout_ms)
     VALUES ($1, $2, 'test tool', $3, NULL, '{}', '{}', $4, $5, $6, $7, $8, $9, $10, 3000) RETURNING id`;
  return {
    tenantId: seeded.tenantId,
    serviceId: seeded.serviceId,
    availabilityToolId: await insert(
      [
        seeded.tenantId,
        'check_availability',
        'BUILT_IN',
        'READ',
        'NONE',
        null,
        null,
        null,
        [],
        'ACTIVE',
      ],
      base,
    ),
    ticketToolId: await insert(
      [
        seeded.tenantId,
        'create_ticket',
        'CUSTOM_API',
        'WRITE',
        'CALLER_CONFIRMATION',
        `http://${HOST}:${String(provider.port)}`,
        'POST',
        '/v1/tickets',
        [HOST],
        'ACTIVE',
      ],
      base,
    ),
    disabledToolId: await insert(
      [
        seeded.tenantId,
        'find_booking',
        'BUILT_IN',
        'READ',
        'NONE',
        null,
        null,
        null,
        [],
        'DISABLED',
      ],
      base,
    ),
  };
}

async function token(
  tenantId: string,
  options: {
    signer?: ServiceSigner;
    audience?: 'connector-worker' | 'control-api';
    scopes?: readonly ServiceScope[];
  } = {},
): Promise<string> {
  return signServiceToken(options.signer ?? controlApi, {
    audience: options.audience ?? 'connector-worker',
    scopes: options.scopes ?? ['connector.execute'],
    tenantId,
  });
}

function message(
  tenantId: string,
  authorization: string | null,
  payload: unknown,
): IncomingExecuteMessage {
  return {
    subject: `svc.v1.connector.execute.${tenantId}`,
    authorization,
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    payload: new TextEncoder().encode(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    ),
  };
}

function payload(
  toolDefinitionId: string,
  toolName: string,
  kind: string,
  args: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tool_run_id: randomUUID().replace(/^(.{14})./, '$17'),
    tool_definition_id: toolDefinitionId,
    tool_name: toolName,
    kind,
    connector_key: null,
    call_id: null,
    arguments: args,
    idempotency_key: `call:${randomUUID()}`,
    timeout_ms: 2_000,
    ...overrides,
  };
}

describe('connector execution requests', () => {
  it('executes built-in and custom API tools for an authorized control-api request', async () => {
    const seeded = await seedTools();
    const availability = await executeMessage(
      deps(),
      message(
        seeded.tenantId,
        `Bearer ${await token(seeded.tenantId)}`,
        payload(seeded.availabilityToolId, 'check_availability', 'BUILT_IN', {
          service_id: seeded.serviceId,
          date_from: '2030-01-08',
          max_results: 2,
        }),
      ),
    );
    expect(availability).toMatchObject({
      status: 'SUCCEEDED',
      error_code: null,
      http_status: null,
    });
    expect((availability.result as { slots: unknown[] }).slots).toHaveLength(2);
    provider.route((incoming) =>
      incoming.path === '/v1/tickets' ? { status: 201, body: { ticket_id: 'T-9' } } : undefined,
    );
    const ticket = await executeMessage(
      deps(),
      message(
        seeded.tenantId,
        `Bearer ${await token(seeded.tenantId)}`,
        payload(seeded.ticketToolId, 'create_ticket', 'CUSTOM_API', { subject: 'Visszahívás' }),
      ),
    );
    expect(ticket).toEqual({
      status: 'SUCCEEDED',
      result: { ticket_id: 'T-9' },
      error_code: null,
      retryable: false,
      http_status: 201,
    });
    const traced = provider.requests.find((entry) => entry.path === '/v1/tickets');
    expect(traced?.headers['traceparent']).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-/);
  });

  it('rejects missing, replayed, foreign, unscoped and non-control-api tokens', async () => {
    const seeded = await seedTools();
    const body = payload(seeded.availabilityToolId, 'check_availability', 'BUILT_IN', {
      service_id: seeded.serviceId,
      date_from: '2030-01-08',
    });
    expect((await executeMessage(deps(), message(seeded.tenantId, null, body))).error_code).toBe(
      'UNAUTHENTICATED',
    );
    const valid = await token(seeded.tenantId);
    expect(
      (await executeMessage(deps(), message(seeded.tenantId, `Bearer ${valid}`, body))).status,
    ).toBe('SUCCEEDED');
    expect(
      (await executeMessage(deps(), message(seeded.tenantId, `Bearer ${valid}`, body))).error_code,
    ).toBe('SERVICE_TOKEN_INVALID');
    const other = await seedTools();
    expect(
      (
        await executeMessage(
          deps(),
          message(seeded.tenantId, `Bearer ${await token(other.tenantId)}`, body),
        )
      ).error_code,
    ).toBe('FORBIDDEN');
    expect(
      (
        await executeMessage(
          deps(),
          message(
            seeded.tenantId,
            `Bearer ${await token(seeded.tenantId, { scopes: ['tool.execute'] })}`,
            body,
          ),
        )
      ).error_code,
    ).toBe('SERVICE_SCOPE_MISSING');
    expect(
      (
        await executeMessage(
          deps(),
          message(
            seeded.tenantId,
            `Bearer ${await token(seeded.tenantId, { audience: 'control-api' })}`,
            body,
          ),
        )
      ).error_code,
    ).toBe('SERVICE_TOKEN_INVALID');
    expect(
      (
        await executeMessage(
          deps(),
          message(
            seeded.tenantId,
            `Bearer ${await token(seeded.tenantId, { signer: voiceRuntime })}`,
            body,
          ),
        )
      ).error_code,
    ).toBe('FORBIDDEN');
  });

  it('validates payloads, matches the stored tool definition and enforces the timeout', async () => {
    const seeded = await seedTools();
    const send = async (body: unknown) =>
      executeMessage(
        deps(),
        message(seeded.tenantId, `Bearer ${await token(seeded.tenantId)}`, body),
      );
    expect((await send('{not json')).error_code).toBe('MALFORMED_REQUEST');
    expect(
      (
        await send({
          ...payload(seeded.availabilityToolId, 'check_availability', 'BUILT_IN', {}),
          extra: true,
        })
      ).error_code,
    ).toBe('VALIDATION_FAILED');
    expect(
      (await send(payload(seeded.availabilityToolId, 'create_booking', 'BUILT_IN', {}))).error_code,
    ).toBe('TOOL_NOT_ALLOWED');
    expect(
      (
        await send(
          payload(seeded.disabledToolId, 'find_booking', 'BUILT_IN', { reference: 'ABCDEF12' }),
        )
      ).error_code,
    ).toBe('TOOL_NOT_ALLOWED');
    expect(
      (
        await send(
          payload(seeded.availabilityToolId, 'check_availability', 'BUILT_IN', {
            service_id: seeded.serviceId,
            date_from: '2030-01-08',
          }),
        )
      ).status,
    ).toBe('SUCCEEDED');
    provider.route((incoming) =>
      incoming.path === '/v1/tickets' && incoming.body.includes('slow')
        ? { status: 200, body: { ok: true }, delayMs: 1_500 }
        : undefined,
    );
    const slow = await send(
      payload(
        seeded.ticketToolId,
        'create_ticket',
        'CUSTOM_API',
        { subject: 'slow' },
        { timeout_ms: 200 },
      ),
    );
    expect(slow).toMatchObject({
      status: 'TIMED_OUT',
      error_code: 'UPSTREAM_TIMEOUT',
      retryable: true,
    });
    const wrongSubject = await executeMessage(deps(), {
      ...message(seeded.tenantId, null, {}),
      subject: 'svc.v1.connector.execute.not-a-tenant',
    });
    expect(wrongSubject.error_code).toBe('VALIDATION_FAILED');
  });
});
