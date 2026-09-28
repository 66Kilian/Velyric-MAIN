import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { AgentConfigSchema } from '@velyric/contracts';
import { ensureBuiltInTools } from '@velyric/db';
import { TenantSecretError } from '@velyric/tenant-secrets';
import { sql } from 'kysely';
import { Value } from 'typebox/value';
import type { CarrierNumberType } from '../providers/telnyx.js';
import type {
  AgentReadiness,
  BeginProvisioningResult,
  GoLiveEvaluation,
  PhoneOrderProgress,
  PhoneReservationResult,
  ProvisioningActivities,
  StateInput,
  WorkflowRowInput,
} from '../workflows/types.js';
import { createNotificationActivity } from './notifications.js';
import {
  appendOutbox,
  applyTenantTransition,
  inTenant,
  newId,
  nonRetryable,
  providerFailure,
  recordStep,
  type ActivityDependencies,
} from './support.js';

const TERMINAL_STATES = new Set(['ACTIVE', 'COMPENSATED', 'CANCELED']);
const PROVISIONABLE_TENANT_STATES = new Set(['PROVISIONING', 'ACTIVE']);
const NUMBER_TYPE_PREFERENCE: readonly CarrierNumberType[] = ['local', 'national', 'mobile'];
const SERVICE_ACCOUNT_NAME = 'velyric-runtime';

function attempt(): number {
  try {
    return Context.current().info.attempt;
  } catch {
    return 1;
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 80) || 'requirement'
  );
}

export function createProvisioningActivities(deps: ActivityDependencies): ProvisioningActivities {
  const notify = createNotificationActivity(deps);

  const step = (
    input: WorkflowRowInput,
    name: string,
    key: string,
    status: 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'COMPENSATED',
    externalRef: string | null = null,
  ) =>
    inTenant(deps, input.tenantId, input.traceId, (trx) =>
      recordStep(trx, {
        tenantId: input.tenantId,
        workflowRowId: input.workflowRowId,
        step: name,
        status,
        idempotencyKey: key,
        externalRef,
      }),
    );

  return {
    notify,

    async beginProvisioning(input): Promise<BeginProvisioningResult> {
      return inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const order = await trx
          .selectFrom('checkout_orders')
          .select(['id', 'status', 'plan_code'])
          .where('id', '=', input.orderId)
          .executeTakeFirst();
        if (order === undefined) {
          throw nonRetryable('order_not_found', 'checkout order does not exist for the tenant');
        }
        if (order.status !== 'PAID') {
          throw nonRetryable('order_not_paid', `checkout order is ${order.status}`);
        }
        let workflow = await trx
          .selectFrom('provisioning_workflows')
          .select(['id', 'state'])
          .where('order_id', '=', input.orderId)
          .executeTakeFirst();
        if (workflow === undefined) {
          workflow = await trx
            .insertInto('provisioning_workflows')
            .values({
              id: newId(),
              tenant_id: input.tenantId,
              order_id: input.orderId,
              temporal_workflow_id: input.workflowId,
              state: 'PAYMENT_CONFIRMED',
            })
            .returning(['id', 'state'])
            .executeTakeFirstOrThrow();
          await recordStep(trx, {
            tenantId: input.tenantId,
            workflowRowId: workflow.id,
            step: 'PAYMENT',
            status: 'SUCCEEDED',
            idempotencyKey: `provisioning:${input.orderId}:payment`,
            externalRef: input.orderId,
          });
          await appendOutbox(
            trx,
            input.tenantId,
            'provisioning.state_changed',
            {
              tenant_id: input.tenantId,
              order_id: input.orderId,
              state: 'PAYMENT_CONFIRMED',
              blocking_reason: null,
            },
            input.traceId,
          );
        }
        const location = await trx
          .selectFrom('locations')
          .select(['id', 'country'])
          .orderBy('is_primary', 'desc')
          .orderBy('created_at')
          .limit(1)
          .executeTakeFirst();
        if (location === undefined) {
          throw nonRetryable('location_missing', 'the tenant has no location');
        }
        return {
          workflowRowId: workflow.id,
          state: workflow.state,
          country: location.country,
          locationId: location.id,
          planCode: order.plan_code,
          alreadyActive: workflow.state === 'ACTIVE',
        };
      });
    },

    async recordState(input: StateInput): Promise<void> {
      await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const current = await trx
          .selectFrom('provisioning_workflows')
          .select(['state', 'blocking_reason', 'order_id'])
          .where('id', '=', input.workflowRowId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (current.state === input.state && current.blocking_reason === input.blockingReason) {
          return;
        }
        await trx
          .updateTable('provisioning_workflows')
          .set((eb) => ({
            state: input.state,
            blocking_reason: input.blockingReason,
            manual_review_reason:
              input.state === 'MANUAL_REVIEW_REQUIRED' ? eb.ref('manual_review_reason') : null,
            completed_at: TERMINAL_STATES.has(input.state) ? new Date() : null,
            version: eb('version', '+', 1),
            updated_at: new Date(),
          }))
          .where('id', '=', input.workflowRowId)
          .execute();
        await appendOutbox(
          trx,
          input.tenantId,
          'provisioning.state_changed',
          {
            tenant_id: input.tenantId,
            order_id: current.order_id,
            state: input.state,
            blocking_reason: input.blockingReason,
          },
          input.traceId,
        );
      });
    },

    async ensureOrderInvoice(input): Promise<void> {
      const order = await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .selectFrom('checkout_orders')
          .select(['stripe_invoice_id'])
          .where('id', '=', input.orderId)
          .executeTakeFirstOrThrow(),
      );
      if (order.stripe_invoice_id === null) {
        throw nonRetryable('order_invoice_missing', 'the paid order has no Stripe invoice');
      }
      const key = `provisioning:${input.orderId}:billing_document`;
      const document = await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .selectFrom('billing_documents')
          .select(['status', 'invoice_number', 'last_error_code'])
          .where('idempotency_key', '=', `stripe_invoice:${order.stripe_invoice_id ?? ''}`)
          .executeTakeFirst(),
      );
      if (
        document !== undefined &&
        (document.status === 'CREATED' ||
          document.status === 'SENT' ||
          document.status === 'SEND_FAILED')
      ) {
        await step(input, 'BILLING_DOCUMENT', key, 'SUCCEEDED', document.invoice_number);
        return;
      }
      if (document?.status === 'FAILED') {
        throw nonRetryable(
          'billing_document_failed',
          'the invoice for the paid order could not be issued',
        );
      }
      await step(input, 'BILLING_DOCUMENT', key, 'WAITING');
      throw ApplicationFailure.create({
        type: 'BillingDocumentPending',
        message: 'waiting for the invoice issuance workflow',
        details: [{ code: 'billing_document_pending' }],
      });
    },

    async ensureTenantProvisioning(input): Promise<void> {
      await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const tenant = await trx
          .selectFrom('tenants')
          .select(['status'])
          .where('id', '=', input.tenantId)
          .executeTakeFirstOrThrow();
        if (!PROVISIONABLE_TENANT_STATES.has(tenant.status)) {
          throw nonRetryable(
            `tenant_not_provisionable:${tenant.status}`,
            `tenant status ${tenant.status} does not allow provisioning`,
          );
        }
        await ensureBuiltInTools(trx, input.tenantId);
        await recordStep(trx, {
          tenantId: input.tenantId,
          workflowRowId: input.workflowRowId,
          step: 'TENANT',
          status: 'SUCCEEDED',
          idempotencyKey: `provisioning:${input.workflowRowId}:tenant`,
          externalRef: input.tenantId,
        });
      });
    },

    async ensureOpenAiProject(input): Promise<string> {
      const existing = await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .selectFrom('provider_resources')
          .select(['external_id'])
          .where('provider', '=', 'openai')
          .where('resource_type', '=', 'project')
          .where('state', '=', 'ACTIVE')
          .executeTakeFirst(),
      );
      if (existing !== undefined) {
        return existing.external_id;
      }
      const key = `provisioning:${input.tenantId}:openai_project`;
      await step(input, 'OPENAI_PROJECT', key, 'RUNNING');
      const name = `velyric-${input.tenantId}`;
      let projectId: string;
      try {
        projectId =
          (await deps.openai.findProjectByName(name)) ?? (await deps.openai.createProject(name));
        const limit = deps.settings.openAiMonthlySpendLimitUsd[input.planCode];
        if (limit !== undefined) {
          await deps.openai.setMonthlySpendLimit(projectId, limit);
        }
      } catch (error) {
        return providerFailure(error);
      }
      await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        await trx
          .insertInto('provider_resources')
          .values({
            id: newId(),
            tenant_id: input.tenantId,
            provider: 'openai',
            resource_type: 'project',
            external_id: projectId,
            state: 'ACTIVE',
            metadata: JSON.stringify({ name }),
          })
          .onConflict((conflict) =>
            conflict
              .columns(['provider', 'resource_type', 'external_id'])
              .doUpdateSet({ state: 'ACTIVE', updated_at: new Date() }),
          )
          .execute();
        await recordStep(trx, {
          tenantId: input.tenantId,
          workflowRowId: input.workflowRowId,
          step: 'OPENAI_PROJECT',
          status: 'SUCCEEDED',
          idempotencyKey: key,
          externalRef: projectId,
        });
      });
      return projectId;
    },

    async ensureOpenAiServiceAccount(input): Promise<void> {
      const active = await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .selectFrom('tenant_secret_refs')
          .select(['id'])
          .where('kind', '=', 'OPENAI_SERVICE_ACCOUNT_KEY')
          .where('provider', '=', 'openai')
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst(),
      );
      if (active !== undefined) {
        return;
      }
      const key = `provisioning:${input.tenantId}:openai_service_account`;
      await step(input, 'OPENAI_SERVICE_ACCOUNT', key, 'RUNNING');
      let credential;
      try {
        const existingAccount = await deps.openai.findServiceAccount(
          input.projectId,
          SERVICE_ACCOUNT_NAME,
        );
        if (existingAccount === null) {
          const created = await deps.openai.createServiceAccount(
            input.projectId,
            SERVICE_ACCOUNT_NAME,
          );
          credential =
            created.credential ??
            (await deps.openai.createServiceAccountKey(
              input.projectId,
              created.serviceAccountId,
              `${SERVICE_ACCOUNT_NAME}-${String(attempt())}`,
            ));
        } else {
          credential = await deps.openai.createServiceAccountKey(
            input.projectId,
            existingAccount,
            `${SERVICE_ACCOUNT_NAME}-${String(attempt())}`,
          );
        }
      } catch (error) {
        return providerFailure(error);
      }
      const secretRefId = newId();
      const version = await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const row = await trx
          .selectFrom('tenant_secret_refs')
          .select((eb) => eb.fn.max('secret_version').as('version'))
          .where('kind', '=', 'OPENAI_SERVICE_ACCOUNT_KEY')
          .where('provider', '=', 'openai')
          .executeTakeFirst();
        return (row?.version ?? 0) + 1;
      });
      let secretRef: string;
      try {
        secretRef = await deps.secrets.store({
          tenantId: input.tenantId,
          kind: 'OPENAI_SERVICE_ACCOUNT_KEY',
          secretRefId,
          version,
          value: credential.apiKey,
        });
      } catch (error) {
        if (error instanceof TenantSecretError && !error.retryable) {
          throw nonRetryable(`secret_store:${error.code}`, error.message);
        }
        throw error;
      }
      try {
        await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
          await trx
            .insertInto('provider_resources')
            .values({
              id: newId(),
              tenant_id: input.tenantId,
              provider: 'openai',
              resource_type: 'service_account',
              external_id: credential.serviceAccountId,
              state: 'ACTIVE',
              metadata: JSON.stringify({
                project_id: input.projectId,
                api_key_id: credential.apiKeyId,
              }),
            })
            .onConflict((conflict) =>
              conflict.columns(['provider', 'resource_type', 'external_id']).doUpdateSet({
                state: 'ACTIVE',
                metadata: JSON.stringify({
                  project_id: input.projectId,
                  api_key_id: credential.apiKeyId,
                }),
                updated_at: new Date(),
              }),
            )
            .execute();
          await trx
            .insertInto('tenant_secret_refs')
            .values({
              id: secretRefId,
              tenant_id: input.tenantId,
              kind: 'OPENAI_SERVICE_ACCOUNT_KEY',
              provider: 'openai',
              secret_ref: secretRef,
              secret_version: version,
              status: 'ACTIVE',
              external_key_id: credential.apiKeyId,
              activated_at: deps.now(),
            })
            .execute();
          const waitingSources = await trx
            .updateTable('knowledge_sources')
            .set((eb) => ({
              status: 'QUEUED',
              last_error_code: null,
              version: eb('version', '+', 1),
              updated_at: deps.now(),
            }))
            .where('tenant_id', '=', input.tenantId)
            .where('status', '=', 'FAILED')
            .where('last_error_code', 'in', [
              'embedding_credentials_missing',
              'embedding_credentials_unavailable',
            ])
            .returning(['id', 'version', 'source_type'])
            .execute();
          for (const source of waitingSources) {
            await appendOutbox(
              trx,
              input.tenantId,
              'knowledge.ingestion_requested',
              {
                tenant_id: input.tenantId,
                source_id: source.id,
                source_version: source.version,
                source_type: source.source_type,
                reason: 'credentials_ready',
              },
              input.traceId,
            );
          }
          await recordStep(trx, {
            tenantId: input.tenantId,
            workflowRowId: input.workflowRowId,
            step: 'OPENAI_SERVICE_ACCOUNT',
            status: 'SUCCEEDED',
            idempotencyKey: key,
            externalRef: credential.serviceAccountId,
          });
          await recordStep(trx, {
            tenantId: input.tenantId,
            workflowRowId: input.workflowRowId,
            step: 'OPENAI_API_KEY',
            status: 'SUCCEEDED',
            idempotencyKey: `${key}:api_key`,
            externalRef: credential.apiKeyId,
          });
        });
      } catch (error) {
        await deps.secrets.scheduleDeletion(secretRef).catch((cleanupError: unknown) => {
          deps.logger.error(
            {
              tenant_id: input.tenantId,
              err: cleanupError instanceof Error ? cleanupError.name : 'unknown',
            },
            'orphaned OpenAI key secret could not be scheduled for deletion',
          );
        });
        throw error;
      }
    },

    async reservePhoneNumber(input): Promise<PhoneReservationResult> {
      const existing = await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .selectFrom('phone_orders')
          .select(['id', 'e164', 'requirements_status', 'status'])
          .where('workflow_id', '=', input.workflowRowId)
          .where('status', 'not in', ['CANCELED', 'FAILED', 'DECLINED', 'NO_INVENTORY'])
          .executeTakeFirst(),
      );
      if (existing !== undefined) {
        return {
          phoneOrderId: existing.id,
          e164: existing.e164,
          requirementsRequired: existing.requirements_status !== 'NOT_REQUIRED',
        };
      }
      const key = `provisioning:${input.orderId}:phone`;
      await step(input, 'PHONE_RESERVATION', key, 'RUNNING');
      const reference = `velyric:${input.orderId}`;
      let reserved: {
        e164: string;
        numberType: CarrierNumberType;
        reservationId: string;
        expiresAt: string | null;
      } | null = null;
      try {
        for (const numberType of NUMBER_TYPE_PREFERENCE) {
          if (reserved !== null) {
            break;
          }
          for (const candidate of await deps.carrier.searchAvailable(
            input.country,
            numberType,
            5,
          )) {
            try {
              const reservation = await deps.carrier.reserve(candidate.e164, reference);
              reserved = {
                e164: candidate.e164,
                numberType,
                reservationId: reservation.reservationId,
                expiresAt: reservation.expiresAt,
              };
              break;
            } catch (error) {
              if (
                error instanceof Error &&
                'retryable' in error &&
                (error as { retryable: boolean }).retryable
              ) {
                throw error;
              }
              deps.logger.warn(
                { tenant_id: input.tenantId, number_type: numberType },
                'phone number reservation was refused; trying the next candidate',
              );
            }
          }
        }
      } catch (error) {
        return providerFailure(error);
      }
      if (reserved === null) {
        throw nonRetryable(
          'phone_no_inventory',
          `no reservable voice numbers are available in ${input.country}`,
        );
      }
      const selected = reserved;
      let requirements;
      try {
        requirements = await deps.carrier.requirements(input.country, selected.numberType);
      } catch (error) {
        return providerFailure(error);
      }
      return inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const phoneOrderId = newId();
        await trx
          .insertInto('phone_orders')
          .values({
            id: phoneOrderId,
            tenant_id: input.tenantId,
            workflow_id: input.workflowRowId,
            provider: 'telnyx',
            provider_reservation_id: selected.reservationId,
            e164: selected.e164,
            country: input.country,
            number_type: selected.numberType.toUpperCase(),
            status: requirements.length > 0 ? 'KYC_REQUIRED' : 'RESERVED',
            requirements_status: requirements.length > 0 ? 'REQUIRED' : 'NOT_REQUIRED',
            inventory_checked_at: deps.now(),
            reserved_until: selected.expiresAt === null ? null : new Date(selected.expiresAt),
            idempotency_key: key,
          })
          .execute();
        if (requirements.length > 0) {
          await trx
            .insertInto('kyc_requirements')
            .values(
              requirements.map((requirement) => ({
                id: newId(),
                tenant_id: input.tenantId,
                phone_order_id: phoneOrderId,
                provider_requirement_id: requirement.requirementId,
                field_type: requirement.fieldType,
                label_key: `carrier.requirement.${slug(requirement.name)}`,
                status: 'REQUIRED',
              })),
            )
            .execute();
        }
        await recordStep(trx, {
          tenantId: input.tenantId,
          workflowRowId: input.workflowRowId,
          step: 'PHONE_RESERVATION',
          status: 'SUCCEEDED',
          idempotencyKey: key,
          externalRef: selected.reservationId,
        });
        if (requirements.length > 0) {
          await recordStep(trx, {
            tenantId: input.tenantId,
            workflowRowId: input.workflowRowId,
            step: 'PHONE_REGULATORY',
            status: 'WAITING',
            idempotencyKey: `${key}:regulatory`,
          });
        }
        return { phoneOrderId, e164: selected.e164, requirementsRequired: requirements.length > 0 };
      });
    },

    async requirementsSubmitted(input): Promise<boolean> {
      return inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const order = await trx
          .selectFrom('phone_orders')
          .select(['requirement_group_ref', 'status'])
          .where('id', '=', input.phoneOrderId)
          .executeTakeFirstOrThrow();
        const outstanding = await trx
          .selectFrom('kyc_requirements')
          .select(['id'])
          .where('phone_order_id', '=', input.phoneOrderId)
          .where('status', 'in', ['REQUIRED', 'DECLINED', 'EXPIRED'])
          .executeTakeFirst();
        const complete = order.requirement_group_ref !== null && outstanding === undefined;
        if (complete && order.status === 'KYC_REQUIRED') {
          await trx
            .updateTable('phone_orders')
            .set((eb) => ({
              status: 'UNDER_REVIEW',
              requirements_status: 'UNDER_REVIEW',
              version: eb('version', '+', 1),
            }))
            .where('id', '=', input.phoneOrderId)
            .execute();
        }
        return complete;
      });
    },

    async orderPhoneNumber(input): Promise<void> {
      const order = await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .selectFrom('phone_orders')
          .select(['e164', 'provider_order_id', 'requirement_group_ref'])
          .where('id', '=', input.phoneOrderId)
          .executeTakeFirstOrThrow(),
      );
      if (order.provider_order_id !== null) {
        return;
      }
      const reference = `velyric:${input.orderId}`;
      const key = `provisioning:${input.orderId}:phone_order`;
      await step(input, 'PHONE_ORDER', key, 'RUNNING');
      let submitted;
      try {
        submitted =
          (await deps.carrier.findOrderByReference(reference)) ??
          (await deps.carrier.createOrder(
            order.e164,
            deps.settings.telnyxConnectionId,
            reference,
            order.requirement_group_ref,
          ));
      } catch (error) {
        return providerFailure(error);
      }
      await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        await trx
          .updateTable('phone_orders')
          .set((eb) => ({
            status: 'ORDER_SUBMITTED',
            provider_order_id: submitted.orderId,
            version: eb('version', '+', 1),
          }))
          .where('id', '=', input.phoneOrderId)
          .execute();
        await recordStep(trx, {
          tenantId: input.tenantId,
          workflowRowId: input.workflowRowId,
          step: 'PHONE_ORDER',
          status: 'WAITING',
          idempotencyKey: key,
          externalRef: submitted.orderId,
        });
      });
    },

    async refreshPhoneOrder(input): Promise<PhoneOrderProgress> {
      const order = await inTenant(deps, input.tenantId, input.traceId, (trx) =>
        trx
          .selectFrom('phone_orders')
          .select(['provider_order_id', 'status', 'requirements_status', 'decline_reason'])
          .where('id', '=', input.phoneOrderId)
          .executeTakeFirstOrThrow(),
      );
      if (order.status === 'APPROVED') {
        return { status: 'APPROVED', declineReason: null };
      }
      if (order.status === 'DECLINED') {
        return { status: 'DECLINED', declineReason: order.decline_reason };
      }
      if (order.provider_order_id === null) {
        throw nonRetryable('phone_order_not_submitted', 'the phone order was never submitted');
      }
      let remote;
      try {
        remote = await deps.carrier.retrieveOrder(order.provider_order_id);
      } catch (error) {
        return providerFailure(error);
      }
      const orderKey = order.provider_order_id;
      return inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        if (remote.status === 'success') {
          await trx
            .updateTable('phone_orders')
            .set((eb) => ({
              status: 'APPROVED',
              requirements_status:
                order.requirements_status === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : 'APPROVED',
              version: eb('version', '+', 1),
            }))
            .where('id', '=', input.phoneOrderId)
            .execute();
          await trx
            .updateTable('kyc_requirements')
            .set({ status: 'APPROVED', reviewed_at: deps.now() })
            .where('phone_order_id', '=', input.phoneOrderId)
            .where('status', 'in', ['SUBMITTED', 'UNDER_REVIEW'])
            .execute();
          await recordStep(trx, {
            tenantId: input.tenantId,
            workflowRowId: input.workflowRowId,
            step: 'PHONE_ORDER',
            status: 'SUCCEEDED',
            idempotencyKey: `${input.phoneOrderId}:carrier`,
            externalRef: orderKey,
          });
          return { status: 'APPROVED', declineReason: null };
        }
        if (remote.status === 'failure') {
          const reason = (remote.requirementsStatus ?? 'carrier_rejected')
            .replace(/[^a-z0-9_-]/gi, '_')
            .slice(0, 100);
          await trx
            .updateTable('phone_orders')
            .set((eb) => ({
              status: 'DECLINED',
              decline_reason: reason,
              requirements_status:
                order.requirements_status === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : 'DECLINED',
              version: eb('version', '+', 1),
            }))
            .where('id', '=', input.phoneOrderId)
            .execute();
          await recordStep(trx, {
            tenantId: input.tenantId,
            workflowRowId: input.workflowRowId,
            step: 'PHONE_ORDER',
            status: 'FAILED',
            idempotencyKey: `${input.phoneOrderId}:carrier`,
            externalRef: orderKey,
          });
          return { status: 'DECLINED', declineReason: reason };
        }
        const underReview =
          remote.requirementsStatus !== null && remote.requirementsStatus.includes('review');
        if (underReview && order.status !== 'UNDER_REVIEW') {
          await trx
            .updateTable('phone_orders')
            .set((eb) => ({ status: 'UNDER_REVIEW', version: eb('version', '+', 1) }))
            .where('id', '=', input.phoneOrderId)
            .execute();
        }
        return { status: underReview ? 'UNDER_REVIEW' : 'PENDING', declineReason: null };
      });
    },

    async activatePhoneNumber(input): Promise<string> {
      return inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const order = await trx
          .selectFrom('phone_orders')
          .selectAll()
          .where('id', '=', input.phoneOrderId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (order.phone_number_id !== null) {
          return order.phone_number_id;
        }
        if (order.status !== 'APPROVED') {
          throw nonRetryable('phone_order_not_approved', `phone order is ${order.status}`);
        }
        const phoneNumberId = newId();
        const inserted = await trx
          .insertInto('phone_numbers')
          .values({
            id: phoneNumberId,
            tenant_id: input.tenantId,
            location_id: input.locationId,
            provider: 'telnyx',
            e164: order.e164,
            country: order.country,
            number_type: order.number_type,
            status: 'ACTIVE',
            provider_number_ref: order.provider_order_id,
            sip_connection_ref: deps.settings.telnyxConnectionId,
          })
          .onConflict((conflict) => conflict.columns(['provider', 'e164']).doNothing())
          .returning(['id'])
          .executeTakeFirst();
        if (inserted === undefined) {
          throw nonRetryable('phone_number_conflict', 'the ordered number is already registered');
        }
        await trx
          .updateTable('phone_orders')
          .set((eb) => ({ phone_number_id: phoneNumberId, version: eb('version', '+', 1) }))
          .where('id', '=', order.id)
          .execute();
        await trx
          .insertInto('provider_resources')
          .values({
            id: newId(),
            tenant_id: input.tenantId,
            provider: 'telnyx',
            resource_type: 'phone_number',
            external_id: order.e164,
            state: 'ACTIVE',
            metadata: JSON.stringify({ order_id: order.provider_order_id }),
          })
          .onConflict((conflict) =>
            conflict
              .columns(['provider', 'resource_type', 'external_id'])
              .doUpdateSet({ state: 'ACTIVE', updated_at: new Date() }),
          )
          .execute();
        await recordStep(trx, {
          tenantId: input.tenantId,
          workflowRowId: input.workflowRowId,
          step: 'SIP_ROUTING',
          status: 'SUCCEEDED',
          idempotencyKey: `${order.id}:sip_routing`,
          externalRef: deps.settings.telnyxConnectionId,
        });
        await appendOutbox(
          trx,
          input.tenantId,
          'phone_number.status_changed',
          {
            tenant_id: input.tenantId,
            phone_number_id: phoneNumberId,
            e164: order.e164,
            status: 'ACTIVE',
          },
          input.traceId,
        );
        return phoneNumberId;
      });
    },

    async checkAgentReadiness(input): Promise<AgentReadiness> {
      return inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const bound = await trx
          .selectFrom('agent_phone_bindings')
          .innerJoin('agents', 'agents.id', 'agent_phone_bindings.agent_id')
          .select(['agents.id'])
          .where('agent_phone_bindings.phone_number_id', '=', input.phoneNumberId)
          .where('agent_phone_bindings.active', '=', true)
          .where('agents.status', '=', 'ACTIVE')
          .where('agents.production_version_id', 'is not', null)
          .executeTakeFirst();
        if (bound !== undefined) {
          return { ready: true, reason: null };
        }
        const number = await trx
          .selectFrom('phone_numbers')
          .select(['location_id'])
          .where('id', '=', input.phoneNumberId)
          .executeTakeFirstOrThrow();
        const agent = await trx
          .selectFrom('agents')
          .select(['id', 'location_id'])
          .where('status', '=', 'ACTIVE')
          .where('production_version_id', 'is not', null)
          .orderBy(sql`location_id is not distinct from ${number.location_id}`, 'desc')
          .orderBy('created_at')
          .limit(1)
          .executeTakeFirst();
        if (agent === undefined) {
          return { ready: false, reason: 'agent_not_published' };
        }
        await trx
          .insertInto('agent_phone_bindings')
          .values({
            id: newId(),
            tenant_id: input.tenantId,
            agent_id: agent.id,
            phone_number_id: input.phoneNumberId,
            priority: 0,
            active: true,
          })
          .onConflict((conflict) =>
            conflict
              .columns(['agent_id', 'phone_number_id'])
              .doUpdateSet({ active: true, updated_at: new Date() }),
          )
          .execute();
        await recordStep(trx, {
          tenantId: input.tenantId,
          workflowRowId: input.workflowRowId,
          step: 'DEFAULT_AGENT',
          status: 'SUCCEEDED',
          idempotencyKey: `${input.phoneNumberId}:agent_binding`,
          externalRef: agent.id,
        });
        return { ready: true, reason: null };
      });
    },

    async evaluateGoLive(input): Promise<GoLiveEvaluation> {
      return inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const failures: string[] = [];
        const now = deps.now();
        const tenant = await trx
          .selectFrom('tenants')
          .select(['status'])
          .where('id', '=', input.tenantId)
          .executeTakeFirstOrThrow();
        if (!PROVISIONABLE_TENANT_STATES.has(tenant.status)) {
          failures.push('tenant_status');
        }
        const entitlement = await trx
          .selectFrom('entitlement_snapshots')
          .select(['billing_period_end'])
          .orderBy('version', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (entitlement === undefined || entitlement.billing_period_end <= now) {
          failures.push('billing_entitlement');
        }
        const number = await trx
          .selectFrom('phone_numbers')
          .select(['status'])
          .where('id', '=', input.phoneNumberId)
          .executeTakeFirst();
        if (number?.status !== 'ACTIVE') {
          failures.push('routing_number');
        }
        const binding = await trx
          .selectFrom('agent_phone_bindings')
          .innerJoin('agents', 'agents.id', 'agent_phone_bindings.agent_id')
          .innerJoin('agent_versions', 'agent_versions.id', 'agents.production_version_id')
          .select(['agent_versions.config', 'agent_versions.status'])
          .where('agent_phone_bindings.phone_number_id', '=', input.phoneNumberId)
          .where('agent_phone_bindings.active', '=', true)
          .orderBy('agent_phone_bindings.priority')
          .limit(1)
          .executeTakeFirst();
        if (binding === undefined) {
          failures.push('routing_binding');
        } else if (!Value.Check(AgentConfigSchema, binding.config)) {
          failures.push('agent_config_invalid');
        } else {
          const config = binding.config;
          const disclosure = config.disclosure.texts[config.default_locale];
          if (disclosure === undefined || disclosure.trim() === '') {
            failures.push('disclosure');
          }
          if (
            config.limits.max_call_duration_seconds <= 0 ||
            config.limits.max_spend_usd_micros_per_call <= 0
          ) {
            failures.push('limits');
          }
          const toolNames = [
            ...new Set(
              config.specialists
                .filter((specialist) => specialist.enabled)
                .flatMap((specialist) => specialist.tool_allowlist),
            ),
          ];
          if (toolNames.length > 0) {
            const tools = await trx
              .selectFrom('tool_definitions')
              .select(['name', 'status'])
              .where('name', 'in', toolNames)
              .execute();
            if (
              tools.length !== toolNames.length ||
              tools.some((tool) => tool.status !== 'ACTIVE')
            ) {
              failures.push('tool_permissions');
            }
          }
          if (binding.status !== 'PRODUCTION') {
            failures.push('mandatory_tests');
          }
        }
        const killSwitch = await trx
          .selectFrom('kill_switches')
          .select(['switch_key'])
          .where('engaged', '=', true)
          .where((eb) =>
            eb.or([
              eb('scope_type', '=', 'GLOBAL'),
              eb.and([eb('scope_type', '=', 'TENANT'), eb('scope_ref', '=', input.tenantId)]),
            ]),
          )
          .where('switch_key', 'in', ['kill.global_new_calls', 'kill.tenant_traffic'])
          .executeTakeFirst();
        if (killSwitch !== undefined) {
          failures.push('kill_switch');
        }
        const unhealthy = await trx
          .selectFrom('provider_health')
          .select(['provider'])
          .where('provider', 'in', ['openai', 'telnyx'])
          .where('status', '=', 'DOWN')
          .where('observed_at', '>', new Date(now.getTime() - 15 * 60_000))
          .executeTakeFirst();
        if (unhealthy !== undefined) {
          failures.push('provider_health');
        }
        return { eligible: failures.length === 0, failures };
      });
    },

    async completeProvisioning(input): Promise<void> {
      await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        await applyTenantTransition(
          trx,
          input.tenantId,
          'PROVISIONING_COMPLETED',
          'provisioning_completed',
          input.traceId,
        );
        const current = await trx
          .selectFrom('provisioning_workflows')
          .select(['state', 'order_id'])
          .where('id', '=', input.workflowRowId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (current.state !== 'ACTIVE') {
          await trx
            .updateTable('provisioning_workflows')
            .set((eb) => ({
              state: 'ACTIVE',
              blocking_reason: null,
              manual_review_reason: null,
              completed_at: deps.now(),
              version: eb('version', '+', 1),
            }))
            .where('id', '=', input.workflowRowId)
            .execute();
          await appendOutbox(
            trx,
            input.tenantId,
            'provisioning.state_changed',
            {
              tenant_id: input.tenantId,
              order_id: current.order_id,
              state: 'ACTIVE',
              blocking_reason: null,
            },
            input.traceId,
          );
        }
        await recordStep(trx, {
          tenantId: input.tenantId,
          workflowRowId: input.workflowRowId,
          step: 'GO_LIVE',
          status: 'SUCCEEDED',
          idempotencyKey: `${input.workflowRowId}:go_live`,
        });
      });
    },

    async markManualReview(input): Promise<void> {
      await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const current = await trx
          .selectFrom('provisioning_workflows')
          .select(['order_id'])
          .where('id', '=', input.workflowRowId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('provisioning_workflows')
          .set((eb) => ({
            state: 'MANUAL_REVIEW_REQUIRED',
            blocking_reason: input.reason.slice(0, 200),
            manual_review_reason: input.reason.slice(0, 200),
            last_error_code: input.reason.slice(0, 200),
            last_error_message: input.errorMessage.slice(0, 1000),
            attempt: eb('attempt', '+', 1),
            version: eb('version', '+', 1),
          }))
          .where('id', '=', input.workflowRowId)
          .execute();
        await appendOutbox(
          trx,
          input.tenantId,
          'provisioning.state_changed',
          {
            tenant_id: input.tenantId,
            order_id: current.order_id,
            state: 'MANUAL_REVIEW_REQUIRED',
            blocking_reason: input.reason,
          },
          input.traceId,
        );
      });
      deps.logger.error(
        { tenant_id: input.tenantId, workflow_row_id: input.workflowRowId, reason: input.reason },
        'provisioning requires manual review',
      );
    },

    async compensateProvisioning(input): Promise<void> {
      const resources = await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        await trx
          .updateTable('phone_orders')
          .set((eb) => ({ status: 'CANCELED', version: eb('version', '+', 1) }))
          .where('workflow_id', '=', input.workflowRowId)
          .where('status', 'in', ['NUMBER_SELECTED', 'RESERVED', 'KYC_REQUIRED', 'UNDER_REVIEW'])
          .execute();
        const numbers = await trx
          .selectFrom('phone_orders')
          .select(['phone_number_id'])
          .where('workflow_id', '=', input.workflowRowId)
          .where('phone_number_id', 'is not', null)
          .execute();
        const numberIds = numbers.flatMap((row) =>
          row.phone_number_id === null ? [] : [row.phone_number_id],
        );
        if (numberIds.length > 0) {
          await trx
            .updateTable('phone_numbers')
            .set((eb) => ({ status: 'RELEASE_PENDING', version: eb('version', '+', 1) }))
            .where('id', 'in', numberIds)
            .where('status', '=', 'ACTIVE')
            .execute();
          await trx
            .updateTable('agent_phone_bindings')
            .set({ active: false, updated_at: new Date() })
            .where('phone_number_id', 'in', numberIds)
            .execute();
        }
        const secrets = await trx
          .updateTable('tenant_secret_refs')
          .set({ status: 'REVOKED', revoked_at: deps.now() })
          .where('kind', '=', 'OPENAI_SERVICE_ACCOUNT_KEY')
          .where('status', '=', 'ACTIVE')
          .returning(['secret_ref'])
          .execute();
        const projects = await trx
          .updateTable('provider_resources')
          .set({ state: 'RELEASING', updated_at: new Date() })
          .where('provider', '=', 'openai')
          .where('resource_type', '=', 'project')
          .where('state', '=', 'ACTIVE')
          .returning(['external_id'])
          .execute();
        return {
          secretRefs: secrets.map((row) => row.secret_ref),
          projectIds: projects.map((row) => row.external_id),
        };
      });
      for (const projectId of resources.projectIds) {
        try {
          await deps.openai.archiveProject(projectId);
        } catch (error) {
          return providerFailure(error);
        }
        await inTenant(deps, input.tenantId, input.traceId, (trx) =>
          trx
            .updateTable('provider_resources')
            .set({ state: 'RELEASED', released_at: deps.now(), updated_at: new Date() })
            .where('provider', '=', 'openai')
            .where('external_id', '=', projectId)
            .execute(),
        );
      }
      for (const secretRef of resources.secretRefs) {
        await deps.secrets.scheduleDeletion(secretRef);
      }
      await inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const current = await trx
          .selectFrom('provisioning_workflows')
          .select(['order_id'])
          .where('id', '=', input.workflowRowId)
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('provisioning_workflows')
          .set((eb) => ({
            state: 'COMPENSATED',
            blocking_reason: input.reason.slice(0, 200),
            completed_at: deps.now(),
            version: eb('version', '+', 1),
          }))
          .where('id', '=', input.workflowRowId)
          .execute();
        await appendOutbox(
          trx,
          input.tenantId,
          'provisioning.state_changed',
          {
            tenant_id: input.tenantId,
            order_id: current.order_id,
            state: 'COMPENSATED',
            blocking_reason: input.reason,
          },
          input.traceId,
        );
      });
    },
  };
}
