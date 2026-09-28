import { createHash, randomBytes } from 'node:crypto';
import { NATS_PROVISIONING_CONTROL_SUBJECT_PREFIX } from '@velyric/contracts';
import {
  ServiceTokenError,
  verifyServiceToken,
  type ServiceTokenVerifier,
} from '@velyric/security';
import Type, { type Static } from 'typebox';
import { Value } from 'typebox/value';
import { inTenant, recordStep, type ActivityDependencies } from './activities/support.js';
import { ProviderCallError } from './providers/errors.js';
import type { CarrierNumberType, CarrierRequirementValue } from './providers/telnyx.js';
import type { WorkflowGateway } from './router.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRACE_PARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const SUBMITTABLE_REQUIREMENT_STATUSES = ['REQUIRED', 'DECLINED', 'EXPIRED'] as const;

const Address = Type.Object(
  {
    business_name: Type.String({ minLength: 1, maxLength: 200 }),
    first_name: Type.String({ minLength: 1, maxLength: 100 }),
    last_name: Type.String({ minLength: 1, maxLength: 100 }),
    street_address: Type.String({ minLength: 1, maxLength: 200 }),
    extended_address: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    locality: Type.String({ minLength: 1, maxLength: 100 }),
    postal_code: Type.String({ minLength: 2, maxLength: 16 }),
    country_code: Type.String({ pattern: '^[A-Z]{2}$' }),
  },
  { additionalProperties: false },
);

const Document = Type.Object(
  {
    filename: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}\\.(pdf|png|jpg|jpeg)$' }),
    content_base64: Type.String({
      minLength: 4,
      maxLength: Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4,
      pattern: '^[A-Za-z0-9+/]+={0,2}$',
    }),
  },
  { additionalProperties: false },
);

export const KycValue = Type.Object(
  {
    kyc_requirement_id: Type.String({ pattern: UUID.source }),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    address: Type.Optional(Address),
    document: Type.Optional(Document),
  },
  { additionalProperties: false },
);

const ControlRequest = Type.Union([
  Type.Object(
    {
      action: Type.Literal('KYC_SUBMIT'),
      phone_order_id: Type.String({ pattern: UUID.source }),
      submitted_by: Type.String({ minLength: 1, maxLength: 200 }),
      values: Type.Array(KycValue, { minItems: 1, maxItems: 20 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal('RETRY'), requested_by: Type.String({ minLength: 1, maxLength: 200 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('CANCEL'),
      requested_by: Type.String({ minLength: 1, maxLength: 200 }),
      reason: Type.String({ pattern: '^[a-z0-9_]{3,100}$' }),
    },
    { additionalProperties: false },
  ),
]);

type ControlRequest = Static<typeof ControlRequest>;
type KycValue = Static<typeof KycValue>;

export type ControlErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'SERVICE_TOKEN_INVALID'
  | 'SERVICE_SCOPE_MISSING'
  | 'MALFORMED_REQUEST'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INVALID_STATE_TRANSITION'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type ControlReply =
  | { readonly ok: true; readonly result: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly error_code: ControlErrorCode;
      readonly details?: Readonly<Record<string, unknown>>;
    };

export interface ControlDependencies {
  readonly activities: ActivityDependencies;
  readonly verifier: ServiceTokenVerifier;
  readonly gateway: WorkflowGateway;
}

export interface IncomingControlMessage {
  readonly subject: string;
  readonly authorization: string | null;
  readonly traceparent: string | null;
  readonly payload: Uint8Array;
}

class ControlFailure extends Error {
  readonly code: ControlErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ControlErrorCode, details?: Readonly<Record<string, unknown>>) {
    super(code);
    this.name = 'ControlFailure';
    this.code = code;
    this.details = details;
  }
}

function failure(
  code: ControlErrorCode,
  details?: Readonly<Record<string, unknown>>,
): ControlReply {
  return details === undefined
    ? { ok: false, error_code: code }
    : { ok: false, error_code: code, details };
}

function traceIdFrom(traceparent: string | null): string {
  const match = traceparent === null ? null : TRACE_PARENT.exec(traceparent);
  return match?.[1] ?? randomBytes(16).toString('hex');
}

function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

function providerFailure(error: unknown): never {
  if (error instanceof ProviderCallError) {
    throw new ControlFailure(
      error.retryable && !error.outcomeUnknown ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR',
      { provider: error.provider, outcome_unknown: error.outcomeUnknown },
    );
  }
  throw error;
}

interface SubmissionContext {
  readonly order: {
    readonly id: string;
    readonly status: string;
    readonly requirements_status: string;
    readonly country: string;
    readonly number_type: string;
    readonly workflow_id: string | null;
    readonly version: number;
  };
  readonly requirements: readonly {
    readonly id: string;
    readonly provider_requirement_id: string;
    readonly field_type: string;
    readonly status: string;
  }[];
  readonly workflow: { readonly id: string; readonly temporal_workflow_id: string } | undefined;
}

async function submitKyc(
  deps: ControlDependencies,
  tenantId: string,
  traceId: string,
  request: Extract<ControlRequest, { action: 'KYC_SUBMIT' }>,
): Promise<Record<string, unknown>> {
  const { activities } = deps;
  const context: SubmissionContext = await inTenant(activities, tenantId, traceId, async (trx) => {
    const order = await trx
      .selectFrom('phone_orders')
      .select([
        'id',
        'status',
        'requirements_status',
        'country',
        'number_type',
        'workflow_id',
        'version',
      ])
      .where('id', '=', request.phone_order_id)
      .executeTakeFirst();
    if (order === undefined) {
      throw new ControlFailure('NOT_FOUND');
    }
    const requirements = await trx
      .selectFrom('kyc_requirements')
      .select(['id', 'provider_requirement_id', 'field_type', 'status'])
      .where('phone_order_id', '=', order.id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const workflow =
      order.workflow_id === null
        ? undefined
        : await trx
            .selectFrom('provisioning_workflows')
            .select(['id', 'temporal_workflow_id'])
            .where('id', '=', order.workflow_id)
            .executeTakeFirst();
    return { order, requirements, workflow };
  });
  if (
    context.order.status !== 'KYC_REQUIRED' ||
    !['REQUIRED', 'DECLINED', 'EXPIRED'].includes(context.order.requirements_status)
  ) {
    throw new ControlFailure('INVALID_STATE_TRANSITION', {
      phone_order_status: context.order.status,
      requirements_status: context.order.requirements_status,
    });
  }
  const open = context.requirements.filter((requirement) =>
    (SUBMITTABLE_REQUIREMENT_STATUSES as readonly string[]).includes(requirement.status),
  );
  const byId = new Map(request.values.map((value) => [value.kyc_requirement_id, value]));
  const issues: { path: string; rule: string }[] = [];
  if (byId.size !== request.values.length) {
    issues.push({ path: '/values', rule: 'unique_requirement' });
  }
  for (const value of request.values) {
    const requirement = context.requirements.find((entry) => entry.id === value.kyc_requirement_id);
    if (requirement === undefined || !open.includes(requirement)) {
      issues.push({ path: `/values/${value.kyc_requirement_id}`, rule: 'open_requirement' });
      continue;
    }
    const provided = [value.text, value.address, value.document].filter(
      (entry) => entry !== undefined,
    ).length;
    const expected =
      requirement.field_type === 'DOCUMENT'
        ? value.document
        : requirement.field_type === 'ADDRESS'
          ? value.address
          : value.text;
    if (provided !== 1 || expected === undefined) {
      issues.push({
        path: `/values/${value.kyc_requirement_id}`,
        rule: `field_type_${requirement.field_type.toLowerCase()}`,
      });
    }
    if (
      value.document !== undefined &&
      Buffer.from(value.document.content_base64, 'base64').length > MAX_DOCUMENT_BYTES
    ) {
      issues.push({ path: `/values/${value.kyc_requirement_id}/document`, rule: 'max_bytes' });
    }
  }
  for (const requirement of open) {
    if (!byId.has(requirement.id)) {
      issues.push({ path: `/values/${requirement.id}`, rule: 'required' });
    }
  }
  if (issues.length > 0) {
    throw new ControlFailure('VALIDATION_FAILED', { issues });
  }

  const submissionNumber = context.order.version;
  const reference = `velyric:${context.order.id}:kyc:${String(submissionNumber)}`;
  const providerValues: CarrierRequirementValue[] = [];
  const stored: {
    readonly id: string;
    readonly hash: Buffer;
    readonly providerRef: string | null;
  }[] = [];
  const retained = context.requirements.filter((requirement) => !open.includes(requirement));
  try {
    for (const requirement of open) {
      const value = byId.get(requirement.id) as KycValue;
      if (value.document !== undefined) {
        const documentId = await activities.carrier.uploadDocument(
          value.document.filename,
          value.document.content_base64,
          `${reference}:${requirement.id}`,
        );
        providerValues.push({
          requirementId: requirement.provider_requirement_id,
          value: documentId,
        });
        stored.push({
          id: requirement.id,
          hash: sha256(Buffer.from(value.document.content_base64, 'base64')),
          providerRef: documentId,
        });
      } else if (value.address !== undefined) {
        const address = value.address;
        const addressId = await activities.carrier.createAddress(
          {
            businessName: address.business_name,
            firstName: address.first_name,
            lastName: address.last_name,
            streetAddress: address.street_address,
            extendedAddress: address.extended_address ?? null,
            locality: address.locality,
            postalCode: address.postal_code,
            countryCode: address.country_code,
          },
          `${reference}:${requirement.id}`,
        );
        providerValues.push({
          requirementId: requirement.provider_requirement_id,
          value: addressId,
        });
        stored.push({
          id: requirement.id,
          hash: sha256(JSON.stringify(address)),
          providerRef: addressId,
        });
      } else {
        const text = (value.text ?? '').trim();
        providerValues.push({ requirementId: requirement.provider_requirement_id, value: text });
        stored.push({ id: requirement.id, hash: sha256(text), providerRef: null });
      }
    }
    const retainedValues =
      retained.length === 0
        ? []
        : await inTenant(activities, tenantId, traceId, (trx) =>
            trx
              .selectFrom('kyc_requirements')
              .select(['provider_requirement_id', 'provider_document_ref'])
              .where(
                'id',
                'in',
                retained.map((requirement) => requirement.id),
              )
              .where('provider_document_ref', 'is not', null)
              .execute(),
          );
    for (const entry of retainedValues) {
      if (entry.provider_document_ref !== null) {
        providerValues.push({
          requirementId: entry.provider_requirement_id,
          value: entry.provider_document_ref,
        });
      }
    }
  } catch (error) {
    return providerFailure(error);
  }

  let groupId: string;
  try {
    groupId = await activities.carrier.createRequirementGroup(
      context.order.country,
      context.order.number_type.toLowerCase() as CarrierNumberType,
      reference,
      providerValues,
    );
  } catch (error) {
    activities.logger.error(
      { tenant_id: tenantId, phone_order_id: context.order.id, reference },
      'requirement group creation failed',
    );
    return providerFailure(error);
  }

  const updated = await inTenant(activities, tenantId, traceId, async (trx) => {
    const result = await trx
      .updateTable('phone_orders')
      .set((eb) => ({
        requirement_group_ref: groupId,
        requirements_status: 'SUBMITTED',
        decline_reason: null,
        status: 'KYC_REQUIRED',
        version: eb('version', '+', 1),
        updated_at: activities.now(),
      }))
      .where('id', '=', context.order.id)
      .where('version', '=', context.order.version)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      return false;
    }
    for (const entry of stored) {
      await trx
        .updateTable('kyc_requirements')
        .set({
          status: 'SUBMITTED',
          submitted_value_hash: entry.hash,
          provider_document_ref: entry.providerRef,
          decline_reason: null,
          submitted_at: activities.now(),
          updated_at: activities.now(),
        })
        .where('id', '=', entry.id)
        .execute();
    }
    if (context.workflow !== undefined) {
      await recordStep(trx, {
        tenantId,
        workflowRowId: context.workflow.id,
        step: 'PHONE_REGULATORY',
        status: 'SUCCEEDED',
        idempotencyKey: reference,
        externalRef: groupId,
      });
    }
    await trx
      .insertInto('audit_logs')
      .values({
        tenant_id: tenantId,
        actor_type: 'SERVICE',
        actor_id: 'workflow-worker',
        action: 'phone_order.kyc_submitted',
        object_type: 'phone_order',
        object_id: context.order.id,
        trace_id: traceId,
        metadata: JSON.stringify({
          submitted_by: request.submitted_by,
          requirement_count: stored.length,
          requirement_group_ref: groupId,
        }),
      })
      .execute();
    return true;
  });
  if (!updated) {
    activities.logger.error(
      { tenant_id: tenantId, phone_order_id: context.order.id, requirement_group_ref: groupId },
      'phone order changed during KYC submission; requirement group needs reconciliation',
    );
    throw new ControlFailure('INVALID_STATE_TRANSITION', { reason: 'concurrent_submission' });
  }
  const signal =
    context.workflow === undefined
      ? 'NOT_FOUND'
      : await deps.gateway.signal(
          context.workflow.temporal_workflow_id,
          'provisioningKycSubmitted',
          [],
        );
  return {
    phone_order_id: context.order.id,
    status: 'SUBMITTED',
    requirement_group_ref: groupId,
    workflow_signaled: signal === 'SIGNALED',
  };
}

async function signalWorkflow(
  deps: ControlDependencies,
  tenantId: string,
  traceId: string,
  request: Exclude<ControlRequest, { action: 'KYC_SUBMIT' }>,
): Promise<Record<string, unknown>> {
  const workflow = await inTenant(deps.activities, tenantId, traceId, (trx) =>
    trx
      .selectFrom('provisioning_workflows')
      .select(['id', 'state', 'temporal_workflow_id'])
      .orderBy('started_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
  );
  if (workflow === undefined) {
    throw new ControlFailure('NOT_FOUND');
  }
  const allowed =
    request.action === 'RETRY'
      ? workflow.state === 'MANUAL_REVIEW_REQUIRED'
      : !['ACTIVE', 'COMPENSATING', 'COMPENSATED', 'CANCELED'].includes(workflow.state);
  if (!allowed) {
    throw new ControlFailure('INVALID_STATE_TRANSITION', { state: workflow.state });
  }
  const outcome =
    request.action === 'RETRY'
      ? await deps.gateway.signal(workflow.temporal_workflow_id, 'provisioningRetry', [])
      : await deps.gateway.signal(workflow.temporal_workflow_id, 'provisioningCancel', [
          request.reason,
        ]);
  if (outcome === 'NOT_FOUND') {
    throw new ControlFailure('INVALID_STATE_TRANSITION', { reason: 'workflow_not_running' });
  }
  await inTenant(deps.activities, tenantId, traceId, (trx) =>
    trx
      .insertInto('audit_logs')
      .values({
        tenant_id: tenantId,
        actor_type: 'SERVICE',
        actor_id: 'workflow-worker',
        action:
          request.action === 'RETRY'
            ? 'provisioning.retry_requested'
            : 'provisioning.cancel_requested',
        object_type: 'provisioning_workflow',
        object_id: workflow.id,
        trace_id: traceId,
        metadata: JSON.stringify(
          request.action === 'RETRY'
            ? { requested_by: request.requested_by }
            : { requested_by: request.requested_by, reason: request.reason },
        ),
      })
      .execute(),
  );
  return { workflow_id: workflow.id, state: workflow.state, signal: request.action };
}

export async function handleControlMessage(
  deps: ControlDependencies,
  message: IncomingControlMessage,
): Promise<ControlReply> {
  const prefix = `${NATS_PROVISIONING_CONTROL_SUBJECT_PREFIX}.`;
  const tenantId = message.subject.startsWith(prefix) ? message.subject.slice(prefix.length) : '';
  if (!UUID.test(tenantId)) {
    return failure('VALIDATION_FAILED');
  }
  const token =
    message.authorization?.startsWith('Bearer ') === true
      ? message.authorization.slice('Bearer '.length)
      : null;
  if (!token) {
    return failure('UNAUTHENTICATED');
  }
  try {
    const verified = await verifyServiceToken(token, deps.verifier, ['provisioning.execute']);
    if (verified.issuer !== 'control-api' || verified.tenantId !== tenantId) {
      return failure('FORBIDDEN');
    }
  } catch (error) {
    if (error instanceof ServiceTokenError) {
      return failure(error.code);
    }
    throw error;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(message.payload));
  } catch {
    return failure('MALFORMED_REQUEST');
  }
  if (!Value.Check(ControlRequest, payload)) {
    return failure('VALIDATION_FAILED');
  }
  const traceId = traceIdFrom(message.traceparent);
  try {
    const result =
      payload.action === 'KYC_SUBMIT'
        ? await submitKyc(deps, tenantId, traceId, payload)
        : await signalWorkflow(deps, tenantId, traceId, payload);
    return { ok: true, result };
  } catch (error) {
    if (error instanceof ControlFailure) {
      return failure(error.code, error.details);
    }
    deps.activities.logger.error(
      { tenant_id: tenantId, err: error instanceof Error ? error.message : String(error) },
      'provisioning control request failed',
    );
    return failure('INTERNAL_ERROR');
  }
}
