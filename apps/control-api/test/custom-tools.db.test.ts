import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { browserHeaders, useApiHarness, type TestUser } from './support/harness.js';
import { seedRuntimeTenant, type SeededTenant } from './support/seed.js';

const harness = useApiHarness();
const BEARER = 'partner-live-token-9f8e7d6c5b4a';
const HMAC = 'hmac-shared-secret-0123456789abcdef0123456789';

let tenant: SeededTenant;

interface Envelope {
  code: string;
  details?: Record<string, unknown>;
}

interface Tool {
  id: string;
  name: string;
  version: number;
  auth_type: string;
  credential_configured: boolean;
  allowed_hosts: string[];
  base_url: string;
  status: string;
  confirmation_policy: string;
}

function toolBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `lookup_ticket_${randomUUID().slice(0, 8).replaceAll('-', '')}`,
    description: 'Looks up a support ticket in the partner CRM by ticket number.',
    http_method: 'GET',
    base_url: 'https://api.partner.test',
    path_template: '/tickets/{ticket_id}',
    input_schema: {
      type: 'object',
      properties: { ticket_id: { type: 'string', pattern: '^[0-9]{4,10}$' } },
      required: ['ticket_id'],
      additionalProperties: false,
    },
    output_schema: {
      type: 'object',
      properties: { status: { type: 'string' } },
      additionalProperties: true,
    },
    side_effect_class: 'READ',
    confirmation_policy: 'NONE',
    idempotency_supported: false,
    auth: { type: 'BEARER', secret: BEARER },
    ...overrides,
  };
}

async function create(
  body: Record<string, unknown>,
  user: TestUser = tenant.owner,
  key = `tool-${randomUUID()}`,
): Promise<{
  statusCode: number;
  json: () => unknown;
  headers: Record<string, unknown>;
  body: string;
}> {
  const response = await harness().app.inject({
    method: 'POST',
    url: '/v1/integrations/custom-tools',
    headers: browserHeaders(user, tenant.tenantId, { 'idempotency-key': key }),
    payload: body,
  });
  return {
    statusCode: response.statusCode,
    json: () => response.json(),
    headers: response.headers,
    body: response.body,
  };
}

async function member(role: string): Promise<TestUser> {
  const user = harness().sessions.issue(
    `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test`,
  );
  const me = await harness().app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: browserHeaders(user),
  });
  const userId = me.json<{ user: { id: string } }>().user.id;
  await harness().admin.query(
    `INSERT INTO app.memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [tenant.tenantId, userId, role],
  );
  return user;
}

function vaultFile(secretRef: string): string {
  return path.join(harness().vaultDir, `${secretRef.slice('local-vault://'.length)}.secret`);
}

beforeAll(async () => {
  tenant = await seedRuntimeTenant(harness());
});

describe('custom API tools', () => {
  it('stores the credential in the secret store, never in the database, API response or audit log', async () => {
    const key = `tool-${randomUUID()}`;
    const body = toolBody();
    const created = await create(body, tenant.owner, key);
    expect(created.statusCode, created.body).toBe(201);
    const tool = created.json() as Tool;
    expect(tool).toMatchObject({
      name: body['name'],
      auth_type: 'BEARER',
      credential_configured: true,
      allowed_hosts: ['api.partner.test'],
      base_url: 'https://api.partner.test',
      version: 1,
    });
    expect(created.body).not.toContain(BEARER);
    expect(created.headers['etag']).toBe('W/"1"');

    const replay = await create(body, tenant.owner, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');

    const refs = await harness().admin.query<{
      id: string;
      secret_ref: string;
      status: string;
      subject_id: string;
      secret_version: number;
    }>(
      `SELECT id, secret_ref, status, subject_id, secret_version FROM app.tenant_secret_refs WHERE tenant_id = $1 AND kind = 'CUSTOM_API_CREDENTIAL'`,
      [tenant.tenantId],
    );
    expect(refs.rows).toEqual([
      expect.objectContaining({ status: 'ACTIVE', subject_id: tool.id, secret_version: 1 }),
    ]);
    expect(await readFile(vaultFile(refs.rows[0]?.secret_ref ?? ''), 'utf8')).toBe(BEARER);
    const leaked = await harness().admin.query<{ count: number }>(
      `SELECT (SELECT count(*) FROM app.tool_definitions WHERE tenant_id = $1 AND row_to_json(tool_definitions)::text LIKE $2)
            + (SELECT count(*) FROM app.audit_logs WHERE tenant_id = $1 AND row_to_json(audit_logs)::text LIKE $2)
            + (SELECT count(*) FROM app.idempotency_keys WHERE tenant_id = $1 AND row_to_json(idempotency_keys)::text LIKE $2) AS count`,
      [tenant.tenantId, `%${BEARER}%`],
    );
    expect(Number(leaked.rows[0]?.count)).toBe(0);

    const second = await create(
      toolBody({
        auth: { type: 'HMAC', secret: HMAC },
        http_method: 'POST',
        base_url: 'https://crm.partner.test',
        path_template: '/callbacks',
        input_schema: {
          type: 'object',
          properties: { phone: { type: 'string' } },
          required: ['phone'],
          additionalProperties: false,
        },
        side_effect_class: 'WRITE',
        confirmation_policy: 'CALLER_CONFIRMATION',
      }),
    );
    expect(second.statusCode, second.body).toBe(201);
    const active = await harness().admin.query(
      `SELECT count(*)::int AS count FROM app.tenant_secret_refs WHERE tenant_id = $1 AND kind = 'CUSTOM_API_CREDENTIAL' AND status = 'ACTIVE'`,
      [tenant.tenantId],
    );
    expect(active.rows[0]).toEqual({ count: 2 });

    const listed = await harness().app.inject({
      method: 'GET',
      url: '/v1/integrations/custom-tools?limit=1',
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json<{ data: Tool[]; page: { next_cursor: string | null } }>();
    expect(page.data).toHaveLength(1);
    expect(page.page.next_cursor).not.toBeNull();
    const detail = await harness().app.inject({
      method: 'GET',
      url: `/v1/integrations/custom-tools/${tool.id}`,
      headers: browserHeaders(tenant.owner, tenant.tenantId),
    });
    expect(detail.json<Tool>().id).toBe(tool.id);
  });

  it('blocks server-side request forgery targets at registration time', async () => {
    const cases: [string, number, string][] = [
      ['https://intranet.partner.test', 422, 'ADDRESS_NOT_PUBLIC'],
      ['https://metadata.partner.test', 422, 'ADDRESS_NOT_PUBLIC'],
      ['https://10.0.0.1', 422, 'ADDRESS_NOT_PUBLIC'],
      ['https://[::1]', 422, 'ADDRESS_NOT_PUBLIC'],
      ['https://user:pass@api.partner.test', 422, 'CREDENTIALS_IN_URL'],
      ['https://api.partner.test:8443', 422, 'PORT_NOT_ALLOWED'],
      ['ftp://api.partner.test', 422, 'SCHEME_NOT_ALLOWED'],
      ['https://unknown.partner.test', 422, 'DNS_RESOLUTION_FAILED'],
      ['not a url at all', 422, 'INVALID_URL'],
    ];
    for (const [baseUrl, status, reason] of cases) {
      const response = await create(toolBody({ base_url: baseUrl }));
      expect(response.statusCode, `${baseUrl}: ${response.body}`).toBe(status);
      expect(response.json()).toMatchObject({ code: 'SSRF_BLOCKED', details: { reason } });
    }
    const withPath = await create(toolBody({ base_url: 'https://api.partner.test/v2' }));
    expect(withPath.statusCode).toBe(400);
    expect((withPath.json() as Envelope).details).toEqual({
      issues: [{ path: '/body/base_url', rule: 'origin_only' }],
    });
    const refs = await harness().admin.query(
      `SELECT count(*)::int AS count FROM app.tool_definitions WHERE tenant_id = $1 AND base_url LIKE '%intranet%'`,
      [tenant.tenantId],
    );
    expect(refs.rows[0]).toEqual({ count: 0 });
  });

  it('rejects unsafe schemas and side-effect policies', async () => {
    const invalidSchema = await create(toolBody({ input_schema: { type: 'string' } }));
    expect(invalidSchema.statusCode).toBe(422);
    expect(invalidSchema.json()).toMatchObject({
      code: 'TOOL_SCHEMA_INVALID',
      details: {
        issues: expect.arrayContaining(['/body/input_schema:root_must_be_object']) as unknown,
      },
    });
    const unknownKeyword = await create(
      toolBody({ output_schema: { type: 'object', 'x-partner': true } }),
    );
    expect((unknownKeyword.json() as Envelope).code).toBe('TOOL_SCHEMA_INVALID');
    const remote = await create(
      toolBody({
        output_schema: {
          type: 'object',
          properties: { a: { $ref: 'https://evil.test/schema.json' } },
        },
      }),
    );
    expect((remote.json() as Envelope).code).toBe('TOOL_SCHEMA_INVALID');
    const placeholder = await create(toolBody({ path_template: '/tickets/{ticket_id}/{secret}' }));
    expect(placeholder.json()).toMatchObject({
      code: 'TOOL_SCHEMA_INVALID',
      details: { issues: ['/body/path_template:placeholder_secret_not_required_input'] },
    });
    const unconfirmedWrite = await create(
      toolBody({
        http_method: 'POST',
        side_effect_class: 'WRITE',
        confirmation_policy: 'NONE',
        idempotency_supported: false,
      }),
    );
    expect(unconfirmedWrite.statusCode).toBe(400);
    const weakHighRisk = await create(
      toolBody({
        http_method: 'POST',
        side_effect_class: 'HIGH_RISK_WRITE',
        confirmation_policy: 'CALLER_CONFIRMATION',
      }),
    );
    expect(weakHighRisk.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ rule: 'high_risk_requires_verification' }] },
    });
    const reserved = await create(toolBody({ name: 'create_booking' }));
    expect(reserved.statusCode).toBe(400);
    const shortHmac = await create(
      toolBody({ auth: { type: 'HMAC', secret: 'too-short-secret' } }),
    );
    expect(shortHmac.statusCode).toBe(400);
  });

  it('updates with optimistic concurrency and never weakens write confirmation', async () => {
    const created = (
      await create(
        toolBody({
          http_method: 'POST',
          side_effect_class: 'WRITE',
          confirmation_policy: 'CALLER_CONFIRMATION',
          input_schema: {
            type: 'object',
            properties: { ticket_id: { type: 'string' } },
            required: ['ticket_id'],
            additionalProperties: false,
          },
        }),
      )
    ).json() as Tool;
    const patch = (headers: Record<string, string>, payload: Record<string, unknown>) =>
      harness().app.inject({
        method: 'PATCH',
        url: `/v1/integrations/custom-tools/${created.id}`,
        headers: browserHeaders(tenant.owner, tenant.tenantId, {
          'idempotency-key': `patch-${randomUUID()}`,
          ...headers,
        }),
        payload,
      });
    expect((await patch({}, { status: 'DISABLED' })).statusCode).toBe(428);
    const weakened = await patch({ 'if-match': 'W/"1"' }, { confirmation_policy: 'NONE' });
    expect(weakened.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ rule: 'cannot_weaken_write_confirmation' }] },
    });
    const disabled = await patch(
      { 'if-match': 'W/"1"' },
      { status: 'DISABLED', confirmation_policy: 'HUMAN_APPROVAL' },
    );
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json<Tool>()).toMatchObject({
      status: 'DISABLED',
      confirmation_policy: 'HUMAN_APPROVAL',
      version: 2,
    });
    const stale = await patch({ 'if-match': 'W/"1"' }, { status: 'ACTIVE' });
    expect(stale.statusCode).toBe(412);
  });

  it('rotates credentials to a new secret version and deletes the old one', async () => {
    const created = (await create(toolBody())).json() as Tool;
    const before = await harness().admin.query<{ secret_ref: string }>(
      `SELECT secret_ref FROM app.tenant_secret_refs WHERE subject_id = $1`,
      [created.id],
    );
    const oldRef = before.rows[0]?.secret_ref ?? '';
    const rotated = await harness().app.inject({
      method: 'POST',
      url: `/v1/integrations/custom-tools/${created.id}/credentials`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `rotate-${randomUUID()}`,
      }),
      payload: { secret: 'partner-live-token-rotated-000111' },
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json<Tool>().version).toBe(2);
    const refs = await harness().admin.query<{
      secret_version: number;
      status: string;
      id: string;
    }>(
      `SELECT id, secret_version, status FROM app.tenant_secret_refs WHERE subject_id = $1 ORDER BY secret_version`,
      [created.id],
    );
    expect(refs.rows.map((row) => [row.secret_version, row.status])).toEqual([
      [1, 'REVOKED'],
      [2, 'ACTIVE'],
    ]);
    const tool = await harness().admin.query<{ auth_secret_ref_id: string }>(
      `SELECT auth_secret_ref_id FROM app.tool_definitions WHERE id = $1`,
      [created.id],
    );
    expect(tool.rows[0]?.auth_secret_ref_id).toBe(refs.rows[1]?.id);
    await vi.waitFor(async () => {
      await expect(readFile(vaultFile(oldRef), 'utf8')).rejects.toThrow();
    });

    const unauthenticated = (await create(toolBody({ auth: { type: 'NONE' } }))).json() as Tool;
    const refused = await harness().app.inject({
      method: 'POST',
      url: `/v1/integrations/custom-tools/${unauthenticated.id}/credentials`,
      headers: browserHeaders(tenant.owner, tenant.tenantId, {
        'idempotency-key': `rotate-${randomUUID()}`,
      }),
      payload: { secret: 'partner-live-token-rotated-000111' },
    });
    expect(refused.statusCode).toBe(409);
  });

  it('requires custom tool management permission to register tools', async () => {
    const viewer = await member('VIEWER');
    expect((await create(toolBody(), viewer)).statusCode).toBe(403);
    const analyst = await member('ANALYST');
    expect((await create(toolBody(), analyst)).statusCode).toBe(403);
  });
});
