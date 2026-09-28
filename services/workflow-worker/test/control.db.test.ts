import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { importServiceSigner, signServiceToken, type ServiceSigner } from '@velyric/security';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  handleControlMessage,
  type ControlDependencies,
  type ControlReply,
} from '../src/control.js';
import { ProviderCallError } from '../src/providers/errors.js';
import type { WorkflowGateway } from '../src/router.js';
import {
  seedKycPhoneOrder,
  testDependencies,
  useTestDatabase,
  type TestProviders,
} from './support/db.js';

const database = useTestDatabase();
const NOW = new Date('2026-09-14T08:00:00Z');
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const PDF = Buffer.from(
  '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF',
).toString('base64');

let controlApi: ServiceSigner;
let voiceRuntime: ServiceSigner;
let jwks: { keys: Record<string, unknown>[] };

class SignalRecorder implements WorkflowGateway {
  readonly signals: { workflowId: string; signalName: string; args: readonly unknown[] }[] = [];
  running = true;

  start(): Promise<'STARTED' | 'ALREADY_STARTED'> {
    return Promise.resolve('STARTED');
  }

  signal(
    workflowId: string,
    signalName: string,
    args: readonly unknown[],
  ): Promise<'SIGNALED' | 'NOT_FOUND'> {
    if (!this.running) {
      return Promise.resolve('NOT_FOUND');
    }
    this.signals.push({ workflowId, signalName, args });
    return Promise.resolve('SIGNALED');
  }
}

beforeAll(async () => {
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
        jwk: {
          ...publicKey.export({ format: 'jwk' }),
          kid: `${issuer}-test`,
          alg: 'EdDSA',
          use: 'sig',
        },
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

function harness(): {
  deps: ControlDependencies;
  providers: TestProviders;
  gateway: SignalRecorder;
} {
  const { deps: activities, providers } = testDependencies(database(), NOW);
  const used = new Set<string>();
  const gateway = new SignalRecorder();
  return {
    providers,
    gateway,
    deps: {
      activities,
      gateway,
      verifier: {
        audience: 'workflow-worker',
        jwks,
        replayGuard: (issuer, jti) => {
          const key = `${issuer}:${jti}`;
          const fresh = !used.has(key);
          used.add(key);
          return Promise.resolve(fresh);
        },
      },
    },
  };
}

async function send(
  deps: ControlDependencies,
  tenantId: string,
  payload: unknown,
  signer: ServiceSigner = controlApi,
  tokenTenant: string = tenantId,
): Promise<ControlReply> {
  const token = await signServiceToken(signer, {
    audience: 'workflow-worker',
    scopes: ['provisioning.execute'],
    tenantId: tokenTenant,
  });
  return handleControlMessage(deps, {
    subject: `svc.v1.provisioning.${tenantId}`,
    authorization: `Bearer ${token}`,
    traceparent: TRACEPARENT,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

const ADDRESS = {
  business_name: 'Demo Rendelő Kft.',
  first_name: 'Anna',
  last_name: 'Kiss',
  street_address: 'Nádor utca 7.',
  locality: 'Budapest',
  postal_code: '1051',
  country_code: 'HU',
};

describe('provisioning control handler', () => {
  it('submits regulatory details straight to the carrier, stores only references and wakes the workflow', async () => {
    const seeded = await seedKycPhoneOrder(database().admin);
    const { deps, providers, gateway } = harness();
    const reply = await send(deps, seeded.tenantId, {
      action: 'KYC_SUBMIT',
      phone_order_id: seeded.phoneOrderId,
      submitted_by: 'user:owner',
      values: [
        { kyc_requirement_id: seeded.requirementIds.text, text: ' 01-09-123456 ' },
        {
          kyc_requirement_id: seeded.requirementIds.document,
          document: { filename: 'lakcimkartya.pdf', content_base64: PDF },
        },
        { kyc_requirement_id: seeded.requirementIds.address, address: ADDRESS },
      ],
    });
    expect(reply).toEqual({
      ok: true,
      result: {
        phone_order_id: seeded.phoneOrderId,
        status: 'SUBMITTED',
        requirement_group_ref: 'rg_1',
        workflow_signaled: true,
      },
    });
    expect(providers.carrier.documents).toEqual([
      {
        filename: 'lakcimkartya.pdf',
        bytes: Buffer.from(PDF, 'base64').length,
        reference: `velyric:${seeded.phoneOrderId}:kyc:1:${seeded.requirementIds.document}`,
      },
    ]);
    expect(providers.carrier.addresses).toHaveLength(1);
    expect(providers.carrier.requirementGroups[0]?.values).toEqual([
      { requirementId: 'req-company-registration', value: '01-09-123456' },
      { requirementId: 'req-proof-of-address', value: 'doc_1' },
      { requirementId: 'req-local-address', value: 'addr_1' },
    ]);
    expect(gateway.signals).toEqual([
      { workflowId: seeded.temporalWorkflowId, signalName: 'provisioningKycSubmitted', args: [] },
    ]);

    const order = await database().admin.query(
      'SELECT status, requirements_status, requirement_group_ref FROM app.phone_orders WHERE id = $1',
      [seeded.phoneOrderId],
    );
    expect(order.rows[0]).toEqual({
      status: 'KYC_REQUIRED',
      requirements_status: 'SUBMITTED',
      requirement_group_ref: 'rg_1',
    });
    const requirements = await database().admin.query<{
      status: string;
      provider_document_ref: string | null;
      hash_length: number;
    }>(
      'SELECT status, provider_document_ref, octet_length(submitted_value_hash) AS hash_length FROM app.kyc_requirements WHERE phone_order_id = $1 ORDER BY created_at',
      [seeded.phoneOrderId],
    );
    expect(requirements.rows).toEqual([
      { status: 'SUBMITTED', provider_document_ref: null, hash_length: 32 },
      { status: 'SUBMITTED', provider_document_ref: 'doc_1', hash_length: 32 },
      { status: 'SUBMITTED', provider_document_ref: 'addr_1', hash_length: 32 },
    ]);
    const stored = await database().admin.query(
      'SELECT count(*)::int AS matches FROM app.audit_logs WHERE tenant_id = $1 AND metadata::text LIKE $2',
      [seeded.tenantId, '%01-09-123456%'],
    );
    expect(stored.rows[0]).toEqual({ matches: 0 });
    const step = await database().admin.query(
      'SELECT step, status, external_ref FROM app.provisioning_step_runs WHERE workflow_id = $1',
      [seeded.workflowRowId],
    );
    expect(step.rows).toEqual([
      { step: 'PHONE_REGULATORY', status: 'SUCCEEDED', external_ref: 'rg_1' },
    ]);

    const again = await send(deps, seeded.tenantId, {
      action: 'KYC_SUBMIT',
      phone_order_id: seeded.phoneOrderId,
      submitted_by: 'user:owner',
      values: [{ kyc_requirement_id: seeded.requirementIds.text, text: 'x' }],
    });
    expect(again).toMatchObject({ ok: false, error_code: 'INVALID_STATE_TRANSITION' });
    expect(providers.carrier.requirementGroups).toHaveLength(1);
  });

  it('rejects incomplete or mistyped submissions before contacting the carrier', async () => {
    const seeded = await seedKycPhoneOrder(database().admin);
    const { deps, providers } = harness();
    const reply = await send(deps, seeded.tenantId, {
      action: 'KYC_SUBMIT',
      phone_order_id: seeded.phoneOrderId,
      submitted_by: 'user:owner',
      values: [
        { kyc_requirement_id: seeded.requirementIds.text, text: '01-09-123456' },
        { kyc_requirement_id: seeded.requirementIds.document, text: 'not a document' },
      ],
    });
    expect(reply).toEqual({
      ok: false,
      error_code: 'VALIDATION_FAILED',
      details: {
        issues: [
          { path: `/values/${seeded.requirementIds.document}`, rule: 'field_type_document' },
          { path: `/values/${seeded.requirementIds.address}`, rule: 'required' },
        ],
      },
    });
    expect(providers.carrier.documents).toHaveLength(0);
    expect(providers.carrier.requirementGroups).toHaveLength(0);
  });

  it('keeps the order open when the carrier fails and reports whether the outcome is unknown', async () => {
    const seeded = await seedKycPhoneOrder(database().admin);
    const { deps, providers, gateway } = harness();
    providers.carrier.requirementGroupFailure = new ProviderCallError(
      'telnyx',
      'telnyx_http_503',
      'unavailable',
      { retryable: true, outcomeUnknown: true, httpStatus: 503 },
    );
    const reply = await send(deps, seeded.tenantId, {
      action: 'KYC_SUBMIT',
      phone_order_id: seeded.phoneOrderId,
      submitted_by: 'user:owner',
      values: [
        { kyc_requirement_id: seeded.requirementIds.text, text: '01-09-123456' },
        {
          kyc_requirement_id: seeded.requirementIds.document,
          document: { filename: 'proof.pdf', content_base64: PDF },
        },
        { kyc_requirement_id: seeded.requirementIds.address, address: ADDRESS },
      ],
    });
    expect(reply).toEqual({
      ok: false,
      error_code: 'PROVIDER_ERROR',
      details: { provider: 'telnyx', outcome_unknown: true },
    });
    const order = await database().admin.query(
      'SELECT requirements_status, requirement_group_ref FROM app.phone_orders WHERE id = $1',
      [seeded.phoneOrderId],
    );
    expect(order.rows[0]).toEqual({ requirements_status: 'REQUIRED', requirement_group_ref: null });
    expect(gateway.signals).toEqual([]);
  });

  it('authenticates the caller, binds the tenant and only retries workflows parked for review', async () => {
    const seeded = await seedKycPhoneOrder(database().admin);
    const { deps, gateway } = harness();
    expect(
      await send(
        deps,
        seeded.tenantId,
        { action: 'RETRY', requested_by: 'support:agent' },
        voiceRuntime,
      ),
    ).toEqual({ ok: false, error_code: 'FORBIDDEN' });
    expect(
      await send(
        deps,
        seeded.tenantId,
        { action: 'RETRY', requested_by: 'support:agent' },
        controlApi,
        randomUUID(),
      ),
    ).toEqual({ ok: false, error_code: 'FORBIDDEN' });
    expect(
      await handleControlMessage(deps, {
        subject: `svc.v1.provisioning.${seeded.tenantId}`,
        authorization: null,
        traceparent: null,
        payload: new Uint8Array(),
      }),
    ).toEqual({ ok: false, error_code: 'UNAUTHENTICATED' });
    expect(
      await send(deps, seeded.tenantId, { action: 'RETRY', requested_by: 'support:agent' }),
    ).toEqual({
      ok: false,
      error_code: 'INVALID_STATE_TRANSITION',
      details: { state: 'WAITING_FOR_CUSTOMER' },
    });

    await database().admin.query(
      `UPDATE app.provisioning_workflows SET state = 'MANUAL_REVIEW_REQUIRED', manual_review_reason = 'phone_order_declined' WHERE id = $1`,
      [seeded.workflowRowId],
    );
    expect(
      await send(deps, seeded.tenantId, { action: 'RETRY', requested_by: 'support:agent' }),
    ).toEqual({
      ok: true,
      result: {
        workflow_id: seeded.workflowRowId,
        state: 'MANUAL_REVIEW_REQUIRED',
        signal: 'RETRY',
      },
    });
    expect(
      await send(deps, seeded.tenantId, {
        action: 'CANCEL',
        requested_by: 'user:owner',
        reason: 'customer_requested_refund',
      }),
    ).toMatchObject({ ok: true });
    expect(gateway.signals.map((signal) => [signal.signalName, signal.args])).toEqual([
      ['provisioningRetry', []],
      ['provisioningCancel', ['customer_requested_refund']],
    ]);
    const audit = await database().admin.query<{ action: string }>(
      'SELECT action FROM app.audit_logs WHERE tenant_id = $1 ORDER BY occurred_at',
      [seeded.tenantId],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['provisioning.retry_requested', 'provisioning.cancel_requested']),
    );
  });
});
