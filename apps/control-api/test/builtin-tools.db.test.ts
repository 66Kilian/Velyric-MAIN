import { randomUUID } from 'node:crypto';
import { BUILT_IN_TOOLS } from '@velyric/contracts';
import { ensureBuiltInTools, withTenantTransaction } from '@velyric/db';
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '../src/runtime/tool-dispatch.js';
import { browserHeaders, useApiHarness } from './support/harness.js';

const harness = useApiHarness();

describe('built-in tool catalog', () => {
  it('registers every built-in tool with strict, compilable schemas when a workspace is created', async () => {
    const owner = harness().sessions.issue(`builtin-${randomUUID().slice(0, 6)}@example.test`);
    const slug = `bt-${randomUUID().slice(0, 8)}`;
    const created = await harness().app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: browserHeaders(owner, undefined, { 'idempotency-key': `ws-${randomUUID()}` }),
      payload: {
        legal_name: `${slug} Kft.`,
        display_name: slug,
        slug,
        default_locale: 'hu',
        timezone: 'Europe/Budapest',
        billing_market: 'HU',
        primary_location: { name: 'Budapest', country: 'HU', timezone: 'Europe/Budapest' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const tenantId = created.json<{ id: string }>().id;
    const rows = await harness().admin.query<{
      name: string;
      kind: string;
      side_effect_class: string;
      confirmation_policy: string;
      input_schema: unknown;
      output_schema: unknown;
      version: number;
    }>(
      `SELECT name, kind, side_effect_class, confirmation_policy, input_schema, output_schema, version FROM app.tool_definitions WHERE tenant_id = $1 ORDER BY name`,
      [tenantId],
    );
    expect(rows.rows.map((row) => row.name)).toEqual(
      BUILT_IN_TOOLS.map((tool) => tool.name).sort(),
    );
    expect(rows.rows.every((row) => row.kind === 'BUILT_IN' && row.version === 1)).toBe(true);
    expect(
      rows.rows
        .filter((row) => row.side_effect_class !== 'READ')
        .map((row) => [row.name, row.confirmation_policy]),
    ).toEqual([
      ['cancel_booking', 'CALLER_CONFIRMATION'],
      ['create_booking', 'CALLER_CONFIRMATION'],
      ['reschedule_booking', 'CALLER_CONFIRMATION'],
    ]);
    const validator = new AjvJsonSchemaValidator();
    for (const row of rows.rows) {
      expect(validator.validate(`${row.name}:in`, row.input_schema, {}).issues).not.toContain(
        '/:schema_uncompilable',
      );
      expect(validator.validate(`${row.name}:out`, row.output_schema, {}).issues).not.toContain(
        '/:schema_uncompilable',
      );
    }
    expect(
      validator.validate(
        'search_knowledge:in',
        rows.rows.find((row) => row.name === 'search_knowledge')?.input_schema,
        { query: 'nyitvatartás' },
      ),
    ).toEqual({ valid: true, issues: [] });
    expect(
      validator.validate(
        'check_availability:in',
        rows.rows.find((row) => row.name === 'check_availability')?.input_schema,
        { service_id: 'nope', date_from: '2030-01-01' },
      ).valid,
    ).toBe(false);

    const context = {
      tenantId,
      actorType: 'SYSTEM' as const,
      actorId: 'test',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    };
    expect(
      await withTenantTransaction(harness().db, context, (trx) =>
        ensureBuiltInTools(trx, tenantId),
      ),
    ).toBe(0);
    await harness().admin.query(
      `UPDATE app.tool_definitions SET description = 'stale' WHERE tenant_id = $1 AND name = 'find_booking'`,
      [tenantId],
    );
    expect(
      await withTenantTransaction(harness().db, context, (trx) =>
        ensureBuiltInTools(trx, tenantId),
      ),
    ).toBe(1);
    const refreshed = await harness().admin.query<{ description: string; version: number }>(
      `SELECT description, version FROM app.tool_definitions WHERE tenant_id = $1 AND name = 'find_booking'`,
      [tenantId],
    );
    expect(refreshed.rows[0]?.version).toBe(2);
    expect(refreshed.rows[0]?.description).not.toBe('stale');

    const reserved = await harness().app.inject({
      method: 'POST',
      url: '/v1/integrations/custom-tools',
      headers: browserHeaders(owner, tenantId, { 'idempotency-key': `tool-${randomUUID()}` }),
      payload: {
        name: 'search_knowledge',
        description: 'Shadowing the built-in knowledge tool.',
        http_method: 'GET',
        base_url: 'https://api.partner.test',
        path_template: '/x',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        side_effect_class: 'READ',
        confirmation_policy: 'NONE',
        idempotency_supported: false,
        auth: { type: 'NONE' },
      },
    });
    expect(reserved.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ path: '/body/name', rule: 'reserved' }] },
    });
  });
});
