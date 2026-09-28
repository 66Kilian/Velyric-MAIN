import type { ApiErrorCode } from '@velyric/contracts';
import Type from 'typebox';
import { idempotentWrite, inTenant, requestMeta, tenantContext, type RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import { writeAudit } from '../persistence.js';
import { requireTenantActor } from '../principal.js';
import type {
  ProvisioningControl,
  ProvisioningControlReply,
} from '../runtime/provisioning-control.js';
import { IdParams, iso, Uuid } from './common.js';

export interface ProvisioningRouteDependencies {
  readonly control: ProvisioningControl;
}

export const MAX_KYC_DOCUMENT_BYTES = 4 * 1024 * 1024;
const KYC_BODY_LIMIT = 12 * 1024 * 1024;

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

const KycSubmissionBody = Type.Object(
  {
    values: Type.Array(
      Type.Object(
        {
          kyc_requirement_id: Uuid,
          text: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
          address: Type.Optional(Address),
          document: Type.Optional(
            Type.Object(
              {
                filename: Type.String({
                  pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}\\.(pdf|png|jpg|jpeg)$',
                }),
                content_base64: Type.String({
                  minLength: 4,
                  maxLength: Math.ceil(MAX_KYC_DOCUMENT_BYTES / 3) * 4,
                  pattern: '^[A-Za-z0-9+/]+={0,2}$',
                }),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);

const CancelBody = Type.Object(
  {
    reason: Type.Union([
      Type.Literal('customer_requested'),
      Type.Literal('duplicate_order'),
      Type.Literal('number_not_suitable'),
    ]),
  },
  { additionalProperties: false },
);

const FORWARDED_ERRORS: ReadonlySet<string> = new Set([
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'INVALID_STATE_TRANSITION',
  'PROVIDER_ERROR',
  'PROVIDER_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
]);

function unwrap(reply: ProvisioningControlReply): Readonly<Record<string, unknown>> {
  if (reply.ok) {
    return reply.result;
  }
  if (!FORWARDED_ERRORS.has(reply.errorCode)) {
    throw new ApiError('INTERNAL_ERROR');
  }
  const retry =
    reply.errorCode === 'SERVICE_UNAVAILABLE' || reply.errorCode === 'PROVIDER_UNAVAILABLE'
      ? { headers: { 'retry-after': '30' } }
      : {};
  throw new ApiError(reply.errorCode as ApiErrorCode, reply.details ?? undefined, retry);
}

export function createProvisioningRoutes(deps: ProvisioningRouteDependencies): RouteModule {
  return (app, services) => {
    app.get('/v1/provisioning', async (request) => {
      const actor = requireTenantActor(request.principal, 'provisioning:read');
      return inTenant(services, actor, request, async (trx) => {
        const workflow = await trx
          .selectFrom('provisioning_workflows')
          .selectAll()
          .orderBy('started_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (workflow === undefined) {
          return { workflow: null, steps: [], phone_orders: [] };
        }
        const steps = await trx
          .selectFrom('provisioning_step_runs')
          .select(['step', 'status', 'attempt', 'error_code', 'started_at', 'finished_at'])
          .where('workflow_id', '=', workflow.id)
          .orderBy('started_at')
          .execute();
        const orders = await trx
          .selectFrom('phone_orders')
          .select([
            'id',
            'e164',
            'country',
            'number_type',
            'status',
            'requirements_status',
            'decline_reason',
            'reserved_until',
            'phone_number_id',
            'version',
            'created_at',
          ])
          .where('workflow_id', '=', workflow.id)
          .orderBy('created_at', 'desc')
          .execute();
        const requirements =
          orders.length === 0
            ? []
            : await trx
                .selectFrom('kyc_requirements')
                .select([
                  'id',
                  'phone_order_id',
                  'field_type',
                  'label_key',
                  'status',
                  'decline_reason',
                  'submitted_at',
                  'reviewed_at',
                ])
                .where(
                  'phone_order_id',
                  'in',
                  orders.map((order) => order.id),
                )
                .orderBy('created_at')
                .orderBy('id')
                .execute();
        return {
          workflow: {
            id: workflow.id,
            order_id: workflow.order_id,
            state: workflow.state,
            blocking_reason: workflow.blocking_reason,
            manual_review_reason: workflow.manual_review_reason,
            started_at: iso(workflow.started_at),
            completed_at: iso(workflow.completed_at),
            updated_at: iso(workflow.updated_at),
          },
          steps: steps.map((step) => ({
            step: step.step,
            status: step.status,
            attempt: step.attempt,
            error_code: step.error_code,
            started_at: iso(step.started_at),
            finished_at: iso(step.finished_at),
          })),
          phone_orders: orders.map((order) => ({
            id: order.id,
            e164: order.e164,
            country: order.country,
            number_type: order.number_type,
            status: order.status,
            requirements_status: order.requirements_status,
            decline_reason: order.decline_reason,
            reserved_until: iso(order.reserved_until),
            phone_number_id: order.phone_number_id,
            version: order.version,
            requirements: requirements
              .filter((requirement) => requirement.phone_order_id === order.id)
              .map((requirement) => ({
                id: requirement.id,
                field_type: requirement.field_type,
                label_key: requirement.label_key,
                status: requirement.status,
                decline_reason: requirement.decline_reason,
                submitted_at: iso(requirement.submitted_at),
                reviewed_at: iso(requirement.reviewed_at),
              })),
          })),
        };
      });
    });

    app.post(
      '/v1/phone-orders/:id/kyc-submissions',
      { bodyLimit: KYC_BODY_LIMIT, schema: { params: IdParams, body: KycSubmissionBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'phone_numbers:order');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'phone_orders.kyc_submit',
          async (trx) => {
            const order = await trx
              .selectFrom('phone_orders')
              .select(['id', 'status'])
              .where('id', '=', request.params.id)
              .executeTakeFirst();
            if (order === undefined) {
              throw new ApiError('NOT_FOUND');
            }
            if (order.status !== 'KYC_REQUIRED') {
              throw new ApiError('INVALID_STATE_TRANSITION', { phone_order_status: order.status });
            }
            const result = unwrap(
              await deps.control.send(
                actor.tenantId,
                {
                  action: 'KYC_SUBMIT',
                  phone_order_id: order.id,
                  submitted_by: `${actor.actorType.toLowerCase()}:${actor.actorId}`,
                  values: request.body.values,
                },
                request.traceId,
              ),
            );
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'phone_order.kyc_submitted',
              objectType: 'phone_order',
              objectId: order.id,
              metadata: {
                requirement_count: request.body.values.length,
                requirement_group_ref: result['requirement_group_ref'] ?? null,
              },
            });
            return { status: 202, body: result };
          },
        );
      },
    );

    app.post(
      '/v1/provisioning/cancel',
      { schema: { body: CancelBody } },
      async (request, reply) => {
        const actor = requireTenantActor(request.principal, 'billing:manage');
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: actor.userId ?? null },
          'provisioning.cancel',
          async (trx) => {
            const result = unwrap(
              await deps.control.send(
                actor.tenantId,
                {
                  action: 'CANCEL',
                  requested_by: `${actor.actorType.toLowerCase()}:${actor.actorId}`,
                  reason: request.body.reason,
                },
                request.traceId,
              ),
            );
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'provisioning.cancel_requested',
              objectType: 'provisioning_workflow',
              objectId: typeof result['workflow_id'] === 'string' ? result['workflow_id'] : null,
              metadata: { reason: request.body.reason },
            });
            return { status: 202, body: result };
          },
        );
      },
    );
  };
}
