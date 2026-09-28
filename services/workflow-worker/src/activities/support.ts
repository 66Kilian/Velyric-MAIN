import { ApplicationFailure } from '@temporalio/common';
import type { TenantStatus, VelyricEnvironment } from '@velyric/contracts';
import { withTenantTransaction, type DB } from '@velyric/db';
import {
  nextTenantStatus,
  TenantTransitionError,
  type TenantLifecycleEvent,
} from '@velyric/domain';
import type { TenantSecretReader, TenantSecretWriter } from '@velyric/tenant-secrets';
import { sql, type Kysely, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { NON_RETRYABLE_ERROR } from '../workflows/types.js';
import type { BillingoApi } from '../providers/billingo.js';
import type { EmailSender } from '../providers/email.js';
import type { TenantEmailOptions } from '../providers/tenant-email.js';
import { ProviderCallError } from '../providers/errors.js';
import type { OpenAiProjectAdmin } from '../providers/openai-admin.js';
import type { BillingGateway } from '../providers/stripe.js';
import type { PhoneCarrier } from '../providers/telnyx.js';

export type Trx = Transaction<DB>;

export interface ActivityLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface ActivitySettings {
  readonly environment: VelyricEnvironment;
  readonly webOrigin: string;
  readonly telnyxConnectionId: string;
  readonly billingoBlockId: number;
  readonly openAiMonthlySpendLimitUsd: Readonly<Record<string, number>>;
}

export interface ActivityDependencies {
  readonly db: Kysely<DB>;
  readonly secrets: TenantSecretWriter & TenantSecretReader;
  readonly openai: OpenAiProjectAdmin;
  readonly carrier: PhoneCarrier;
  readonly billingo: BillingoApi;
  readonly billing: BillingGateway;
  readonly email: EmailSender;
  readonly tenantEmail: TenantEmailOptions;
  readonly settings: ActivitySettings;
  readonly now: () => Date;
  readonly logger: ActivityLogger;
}

export function newId(): string {
  return uuidv7();
}

export function nonRetryable(code: string, message: string): ApplicationFailure {
  return ApplicationFailure.create({
    type: NON_RETRYABLE_ERROR,
    message,
    nonRetryable: true,
    details: [{ code }],
  });
}

export function providerFailure(error: unknown): never {
  if (error instanceof ProviderCallError) {
    if (!error.retryable || error.outcomeUnknown) {
      throw nonRetryable(
        error.outcomeUnknown
          ? `${error.provider}_outcome_unknown`
          : `${error.provider}:${error.code}`,
        error.message,
      );
    }
    throw ApplicationFailure.create({
      type: 'ProviderUnavailable',
      message: `${error.provider}: ${error.message}`,
      details: [{ code: `${error.provider}:${error.code}` }],
    });
  }
  throw error;
}

export function inTenant<T>(
  deps: ActivityDependencies,
  tenantId: string,
  traceId: string,
  fn: (trx: Trx) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(
    deps.db,
    { tenantId, actorType: 'SERVICE', actorId: 'workflow-worker', traceId },
    fn,
  );
}

export async function appendOutbox(
  trx: Trx,
  tenantId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
  traceId: string,
): Promise<void> {
  await sql`
    insert into app.outbox_events (tenant_id, event_id, event_type, schema_version, subject, payload, trace_id, occurred_at)
    values (${tenantId}, ${newId()}, ${eventType}, 1, ${`domain.v1.${tenantId}.${eventType}`}, ${JSON.stringify(payload)}::jsonb, ${traceId}, now())`.execute(
    trx,
  );
}

export async function applyTenantTransition(
  trx: Trx,
  tenantId: string,
  event: TenantLifecycleEvent,
  reason: string,
  traceId: string,
): Promise<{ readonly from: TenantStatus; readonly to: TenantStatus; readonly changed: boolean }> {
  const tenant = await trx
    .selectFrom('tenants')
    .select(['status', 'version'])
    .where('id', '=', tenantId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const from = tenant.status as TenantStatus;
  let to: TenantStatus;
  try {
    to = nextTenantStatus(from, event);
  } catch (error) {
    if (error instanceof TenantTransitionError) {
      return { from, to: from, changed: false };
    }
    throw error;
  }
  if (to === from) {
    return { from, to, changed: false };
  }
  await trx
    .updateTable('tenants')
    .set({
      status: to,
      status_reason: reason,
      status_changed_at: new Date(),
      version: tenant.version + 1,
    })
    .where('id', '=', tenantId)
    .execute();
  await trx
    .insertInto('tenant_status_history')
    .values({
      id: newId(),
      tenant_id: tenantId,
      from_status: from,
      to_status: to,
      reason,
      actor_type: 'SERVICE',
      actor_id: 'workflow-worker',
    })
    .execute();
  await appendOutbox(
    trx,
    tenantId,
    'tenant.status_changed',
    { tenant_id: tenantId, from_status: from, to_status: to, reason },
    traceId,
  );
  return { from, to, changed: true };
}

export async function recordStep(
  trx: Trx,
  input: {
    readonly tenantId: string;
    readonly workflowRowId: string;
    readonly step: string;
    readonly status: 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'COMPENSATED';
    readonly idempotencyKey: string;
    readonly externalRef?: string | null;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  },
): Promise<void> {
  const finished = input.status === 'RUNNING' || input.status === 'WAITING' ? null : new Date();
  const existing = await trx
    .selectFrom('provisioning_step_runs')
    .select(['id', 'status'])
    .where('workflow_id', '=', input.workflowRowId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .orderBy('attempt', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (
    existing !== undefined &&
    (existing.status === 'RUNNING' ||
      existing.status === 'WAITING' ||
      existing.status === input.status)
  ) {
    await trx
      .updateTable('provisioning_step_runs')
      .set({
        status: input.status,
        external_ref: input.externalRef ?? null,
        error_code: input.errorCode ?? null,
        error_message: input.errorMessage?.slice(0, 1000) ?? null,
        finished_at: finished,
        updated_at: new Date(),
      })
      .where('id', '=', existing.id)
      .execute();
    return;
  }
  const attempt = await trx
    .selectFrom('provisioning_step_runs')
    .select((eb) => eb.fn.max('attempt').as('attempt'))
    .where('tenant_id', '=', input.tenantId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  await trx
    .insertInto('provisioning_step_runs')
    .values({
      id: newId(),
      tenant_id: input.tenantId,
      workflow_id: input.workflowRowId,
      step: input.step,
      status: input.status,
      attempt: (attempt?.attempt ?? 0) + 1,
      idempotency_key: input.idempotencyKey,
      external_ref: input.externalRef ?? null,
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage?.slice(0, 1000) ?? null,
      finished_at: finished,
    })
    .execute();
}

export function formatMinor(amountMinor: number, currency: string, locale: string): string {
  const intlLocale = locale === 'hu' ? 'hu-HU' : locale === 'de' ? 'de-DE' : 'en-GB';
  return new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'HUF' ? 0 : 2,
    minimumFractionDigits: currency === 'HUF' ? 0 : 2,
  }).format(amountMinor / 100);
}

export function formatDate(instant: Date, locale: string): string {
  const intlLocale = locale === 'hu' ? 'hu-HU' : locale === 'de' ? 'de-DE' : 'en-GB';
  return new Intl.DateTimeFormat(intlLocale, {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(instant);
}

export function formatDateTime(instant: Date, locale: string): string {
  const intlLocale = locale === 'hu' ? 'hu-HU' : locale === 'de' ? 'de-DE' : 'en-GB';
  return new Intl.DateTimeFormat(intlLocale, {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant);
}
