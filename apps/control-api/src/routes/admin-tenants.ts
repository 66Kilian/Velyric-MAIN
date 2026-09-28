import { PlatformPermission } from '@velyric/contracts';
import { sql } from 'kysely';
import Type from 'typebox';
import { requestMeta, type RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import { appendOutbox, newId, writeAudit, type Trx } from '../persistence.js';
import {
  inPlatform,
  inTenantAsStaff,
  requireStaff,
  staffHasPermission,
  type StaffActor,
} from '../staff.js';
import { domainSubject, iso, Uuid } from './common.js';

const TenantParams = Type.Object({ id: Uuid }, { additionalProperties: false });

const StatusBody = Type.Object(
  {
    status: Type.Union([
      Type.Literal('ACTIVE'),
      Type.Literal('RESTRICTED'),
      Type.Literal('SUSPENDED_ADMIN'),
      Type.Literal('SUSPENDED_RISK'),
    ]),
    reason: Type.String({ minLength: 10, maxLength: 500 }),
  },
  { additionalProperties: false },
);

const UsageQuery = Type.Object(
  { period: Type.Optional(Type.String({ format: 'date-time' })) },
  { additionalProperties: false },
);

const UsageAdjustmentBody = Type.Object(
  {
    billing_period_start: Type.String({ format: 'date-time' }),
    metric: Type.String({ pattern: '^[a-z][a-z_]{2,60}$' }),
    delta_quantity: Type.Integer({ minimum: -1_000_000_000, maximum: 1_000_000_000 }),
    delta_cost_usd_micros: Type.Optional(
      Type.Integer({ minimum: -1_000_000_000_000, maximum: 1_000_000_000_000 }),
    ),
    reason: Type.String({ minLength: 10, maxLength: 500 }),
  },
  { additionalProperties: false },
);

const BalanceBody = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('CREDIT'),
      Type.Literal('DEBIT'),
      Type.Literal('ADJUSTMENT'),
      Type.Literal('REFUND'),
      Type.Literal('GOODWILL'),
    ]),
    amount_minor: Type.Integer({ minimum: -100_000_000, maximum: 100_000_000 }),
    currency: Type.Union([Type.Literal('HUF'), Type.Literal('EUR'), Type.Literal('USD')]),
    reason: Type.String({ minLength: 10, maxLength: 500 }),
    external_ref: Type.Optional(Type.String({ maxLength: 120 })),
  },
  { additionalProperties: false },
);

const BudgetBody = Type.Object(
  {
    period_budget_usd_micros: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
    ),
    daily_cap_usd_micros: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000_000_000 })),
    monthly_cap_usd_micros: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000_000_000 })),
    clear_hard_cap: Type.Optional(Type.Boolean()),
    reason: Type.String({ minLength: 10, maxLength: 500 }),
  },
  { additionalProperties: false },
);

const NumberParams = Type.Object({ id: Uuid, number_id: Uuid }, { additionalProperties: false });

const NumberStatusBody = Type.Object(
  {
    status: Type.Union([
      Type.Literal('ACTIVE'),
      Type.Literal('SUSPENDED'),
      Type.Literal('RELEASE_PENDING'),
    ]),
    reason: Type.String({ minLength: 10, maxLength: 500 }),
  },
  { additionalProperties: false },
);

const SecretParams = Type.Object({ id: Uuid, secret_id: Uuid }, { additionalProperties: false });

const RevokeBody = Type.Object(
  { reason: Type.String({ minLength: 10, maxLength: 500 }) },
  { additionalProperties: false },
);

const SupportSessionBody = Type.Object(
  {
    access_level: Type.Union([Type.Literal('REDACTED'), Type.Literal('SENSITIVE')]),
    reason: Type.String({ minLength: 10, maxLength: 2000 }),
    incident_ref: Type.Optional(Type.String({ maxLength: 120 })),
    minutes: Type.Optional(Type.Integer({ minimum: 15, maximum: 480 })),
  },
  { additionalProperties: false },
);

const GrantParams = Type.Object({ id: Uuid, grant_id: Uuid }, { additionalProperties: false });

const DaysQuery = Type.Object(
  { days: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })) },
  { additionalProperties: false },
);

function staffActor(staff: StaffActor, tenantId: string) {
  return {
    tenantId,
    actorType: 'SUPPORT_STAFF' as const,
    actorId: staff.userId,
    role: null,
    locationScope: [] as readonly string[],
  };
}

async function assertTenant(trx: Trx, tenantId: string): Promise<{ status: string }> {
  const row = await trx
    .selectFrom('tenants')
    .select(['status'])
    .where('id', '=', tenantId)
    .executeTakeFirst();
  if (row === undefined) {
    throw new ApiError('NOT_FOUND');
  }
  return row;
}

export const registerAdminTenantRoutes: RouteModule = (app, services) => {
  app.post(
    '/v1/admin/tenants/:id/status',
    { schema: { params: TenantParams, body: StatusBody } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.TENANTS_SUSPEND);
      const tenantId = request.params.id;
      const body = request.body;
      return inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
        const tenant = await assertTenant(trx, tenantId);
        if (tenant.status === body.status) {
          throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'already_in_status' });
        }
        const now = services.now();
        await trx
          .updateTable('tenants')
          .set((eb) => ({
            status: body.status,
            status_reason: body.reason,
            status_changed_at: now,
            version: eb('version', '+', 1),
            updated_at: now,
          }))
          .where('id', '=', tenantId)
          .execute();
        await trx
          .insertInto('tenant_status_history')
          .values({
            id: newId(),
            tenant_id: tenantId,
            from_status: tenant.status,
            to_status: body.status,
            reason: body.reason,
            actor_type: 'SUPPORT_STAFF',
            actor_id: staff.userId,
          })
          .execute();
        await appendOutbox(trx, {
          tenantId,
          eventType: 'tenant.status_changed',
          subject: domainSubject(tenantId, 'tenant.status_changed'),
          payload: { tenant_id: tenantId, from: tenant.status, to: body.status },
          traceId: request.traceId,
        });
        await writeAudit(trx, staffActor(staff, tenantId), requestMeta(request), {
          action: 'tenant.status_changed',
          objectType: 'tenant',
          objectId: tenantId,
          actorLabel: staff.email,
          metadata: { from: tenant.status, to: body.status, reason: body.reason },
        });
        return { id: tenantId, status: body.status, status_reason: body.reason };
      });
    },
  );

  app.get(
    '/v1/admin/tenants/:id/usage',
    { schema: { params: TenantParams, querystring: UsageQuery } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.TENANTS_READ);
      const result = await inPlatform(services, staff, request, async (trx) => {
        const usage = await sql<{
          billing_period_start: Date;
          metric: string;
          quantity: string;
          adjusted_quantity: string;
          cost_usd_micros: string;
          adjusted_cost_usd_micros: string;
          event_count: string;
          last_event_occurred_at: Date | null;
        }>`select * from app.admin_tenant_usage(
            ${request.params.id}::uuid, ${request.query.period ?? null}::timestamptz)`.execute(trx);
        const periods = await sql<{ billing_period_start: Date }>`
          select * from app.admin_tenant_periods(${request.params.id}::uuid)`.execute(trx);
        return { usage: usage.rows, periods: periods.rows };
      });
      return {
        period: iso(result.usage[0]?.billing_period_start ?? null),
        periods: result.periods.map((row) => iso(row.billing_period_start)),
        data: result.usage.map((row) => ({
          metric: row.metric,
          quantity: Number(row.quantity),
          adjusted_quantity: Number(row.adjusted_quantity),
          cost_usd_micros: Number(row.cost_usd_micros),
          adjusted_cost_usd_micros: Number(row.adjusted_cost_usd_micros),
          event_count: Number(row.event_count),
          last_event_occurred_at: iso(row.last_event_occurred_at),
        })),
      };
    },
  );

  app.post(
    '/v1/admin/tenants/:id/usage-adjustments',
    { schema: { params: TenantParams, body: UsageAdjustmentBody } },
    async (request, reply) => {
      const staff = requireStaff(request.principal, PlatformPermission.USAGE_MANAGE);
      const tenantId = request.params.id;
      const body = request.body;
      const created = await inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
        await assertTenant(trx, tenantId);
        const row = await trx
          .insertInto('usage_adjustments')
          .values({
            tenant_id: tenantId,
            billing_period_start: new Date(body.billing_period_start),
            metric: body.metric,
            delta_quantity: body.delta_quantity,
            delta_cost_usd_micros: body.delta_cost_usd_micros ?? 0,
            reason: body.reason,
            staff_user_id: staff.userId,
            staff_label: staff.email,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, staffActor(staff, tenantId), requestMeta(request), {
          action: 'usage.adjusted',
          objectType: 'usage_adjustment',
          objectId: row.id,
          actorLabel: staff.email,
          metadata: {
            metric: body.metric,
            delta_quantity: body.delta_quantity,
            reason: body.reason,
          },
        });
        return row;
      });
      return reply.code(201).send({
        id: created.id,
        metric: created.metric,
        delta_quantity: Number(created.delta_quantity),
        delta_cost_usd_micros: Number(created.delta_cost_usd_micros),
        reason: created.reason,
        created_at: iso(created.created_at),
      });
    },
  );

  app.get(
    '/v1/admin/tenants/:id/finance',
    { schema: { params: TenantParams } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.TENANTS_READ);
      const tenantId = request.params.id;
      return inPlatform(services, staff, request, async (trx) => {
        const [balances, entries, budget, subscription, documents, profile] = await Promise.all([
          trx
            .selectFrom('billing_balances')
            .selectAll()
            .where('tenant_id', '=', tenantId)
            .execute(),
          trx
            .selectFrom('balance_entries')
            .selectAll()
            .where('tenant_id', '=', tenantId)
            .orderBy('created_at', 'desc')
            .limit(50)
            .execute(),
          trx
            .selectFrom('cost_budgets')
            .selectAll()
            .where('tenant_id', '=', tenantId)
            .orderBy('billing_period_start', 'desc')
            .limit(1)
            .executeTakeFirst(),
          trx
            .selectFrom('subscriptions')
            .selectAll()
            .where('tenant_id', '=', tenantId)
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst(),
          trx
            .selectFrom('billing_documents')
            .select([
              'id',
              'document_type',
              'status',
              'invoice_number',
              'total_minor',
              'currency',
              'issued_at',
              'created_at',
            ])
            .where('tenant_id', '=', tenantId)
            .orderBy('created_at', 'desc')
            .limit(20)
            .execute(),
          trx
            .selectFrom('billing_profiles')
            .select([
              'billing_email',
              'legal_name',
              'country',
              'customer_type',
              'hu_tax_number',
              'eu_vat_id',
              'stripe_customer_id',
            ])
            .where('tenant_id', '=', tenantId)
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst(),
        ]);
        return {
          balances: balances.map((row) => ({
            currency: row.currency,
            balance_minor: Number(row.balance_minor),
            entry_count: row.entry_count,
            updated_at: iso(row.updated_at),
          })),
          entries: entries.map((row) => ({
            id: row.id,
            kind: row.kind,
            amount_minor: Number(row.amount_minor),
            currency: row.currency,
            reason: row.reason,
            external_ref: row.external_ref,
            staff_label: row.staff_label,
            created_at: iso(row.created_at),
          })),
          budget:
            budget === undefined
              ? null
              : {
                  id: budget.id,
                  billing_period_start: iso(budget.billing_period_start),
                  billing_period_end: iso(budget.billing_period_end),
                  period_budget_usd_micros: Number(budget.period_budget_usd_micros),
                  consumed_usd_micros: Number(budget.consumed_usd_micros),
                  daily_cap_usd_micros: Number(budget.daily_cap_usd_micros),
                  monthly_cap_usd_micros: Number(budget.monthly_cap_usd_micros),
                  unlocked_quarters: budget.unlocked_quarters,
                  hard_cap_reached_at: iso(budget.hard_cap_reached_at),
                  version: budget.version,
                },
          subscription:
            subscription === undefined
              ? null
              : {
                  status: subscription.status,
                  plan_code: subscription.plan_code,
                  currency: subscription.currency,
                  current_period_start: iso(subscription.current_period_start),
                  current_period_end: iso(subscription.current_period_end),
                  cancel_at_period_end: subscription.cancel_at_period_end,
                  pending_plan_code: subscription.pending_plan_code,
                  stripe_subscription_id: subscription.stripe_subscription_id,
                },
          documents: documents.map((row) => ({
            id: row.id,
            document_type: row.document_type,
            status: row.status,
            invoice_number: row.invoice_number,
            total_minor: Number(row.total_minor),
            currency: row.currency,
            issued_at: iso(row.issued_at),
            created_at: iso(row.created_at),
          })),
          profile:
            profile === undefined
              ? null
              : {
                  billing_email: profile.billing_email,
                  legal_name: profile.legal_name,
                  country: profile.country,
                  customer_type: profile.customer_type,
                  tax_number: profile.hu_tax_number ?? profile.eu_vat_id,
                  stripe_customer_id: profile.stripe_customer_id,
                },
        };
      });
    },
  );

  app.post(
    '/v1/admin/tenants/:id/balance-entries',
    { schema: { params: TenantParams, body: BalanceBody } },
    async (request, reply) => {
      const staff = requireStaff(request.principal, PlatformPermission.BALANCE_MANAGE);
      const tenantId = request.params.id;
      const body = request.body;
      const signed =
        body.kind === 'DEBIT' ? -Math.abs(body.amount_minor) : Math.abs(body.amount_minor);
      if (signed === 0) {
        throw new ApiError('VALIDATION_FAILED', {
          issues: [{ path: '/body/amount_minor', rule: 'non_zero' }],
        });
      }
      const created = await inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
        await assertTenant(trx, tenantId);
        const row = await trx
          .insertInto('balance_entries')
          .values({
            tenant_id: tenantId,
            kind: body.kind,
            amount_minor: signed,
            currency: body.currency,
            reason: body.reason,
            external_ref: body.external_ref ?? null,
            staff_user_id: staff.userId,
            staff_label: staff.email,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, staffActor(staff, tenantId), requestMeta(request), {
          action: 'billing.balance_adjusted',
          objectType: 'balance_entry',
          objectId: row.id,
          actorLabel: staff.email,
          metadata: {
            kind: body.kind,
            amount_minor: signed,
            currency: body.currency,
            reason: body.reason,
          },
        });
        const balance = await trx
          .selectFrom('billing_balances')
          .select(['balance_minor'])
          .where('tenant_id', '=', tenantId)
          .where('currency', '=', body.currency)
          .executeTakeFirst();
        return { row, balance: Number(balance?.balance_minor ?? 0) };
      });
      return reply.code(201).send({
        id: created.row.id,
        kind: created.row.kind,
        amount_minor: Number(created.row.amount_minor),
        currency: created.row.currency,
        balance_minor: created.balance,
        created_at: iso(created.row.created_at),
      });
    },
  );

  app.patch(
    '/v1/admin/tenants/:id/budget',
    { schema: { params: TenantParams, body: BudgetBody } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.BILLING_MANAGE);
      const tenantId = request.params.id;
      const body = request.body;
      return inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
        const budget = await trx
          .selectFrom('cost_budgets')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .orderBy('billing_period_start', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (budget === undefined) {
          throw new ApiError('NOT_FOUND', { reason: 'no_budget_for_tenant' });
        }
        const daily = body.daily_cap_usd_micros ?? Number(budget.daily_cap_usd_micros);
        const monthly = body.monthly_cap_usd_micros ?? Number(budget.monthly_cap_usd_micros);
        if (daily > monthly) {
          throw new ApiError('VALIDATION_FAILED', {
            issues: [{ path: '/body/daily_cap_usd_micros', rule: 'daily_over_monthly' }],
          });
        }
        await trx
          .updateTable('cost_budgets')
          .set((eb) => ({
            ...(body.period_budget_usd_micros === undefined
              ? {}
              : { period_budget_usd_micros: body.period_budget_usd_micros }),
            daily_cap_usd_micros: daily,
            monthly_cap_usd_micros: monthly,
            ...(body.clear_hard_cap === true
              ? { hard_cap_reached_at: null, soft_warning_sent_at: null }
              : {}),
            version: eb('version', '+', 1),
            updated_at: services.now(),
          }))
          .where('id', '=', budget.id)
          .execute();
        await writeAudit(trx, staffActor(staff, tenantId), requestMeta(request), {
          action: 'billing.budget_updated',
          objectType: 'cost_budget',
          objectId: budget.id,
          actorLabel: staff.email,
          metadata: {
            reason: body.reason,
            cleared_hard_cap: body.clear_hard_cap === true,
            daily_cap_usd_micros: daily,
            monthly_cap_usd_micros: monthly,
          },
        });
        const updated = await trx
          .selectFrom('cost_budgets')
          .selectAll()
          .where('id', '=', budget.id)
          .executeTakeFirstOrThrow();
        return {
          id: updated.id,
          period_budget_usd_micros: Number(updated.period_budget_usd_micros),
          consumed_usd_micros: Number(updated.consumed_usd_micros),
          daily_cap_usd_micros: Number(updated.daily_cap_usd_micros),
          monthly_cap_usd_micros: Number(updated.monthly_cap_usd_micros),
          hard_cap_reached_at: iso(updated.hard_cap_reached_at),
          version: updated.version,
        };
      });
    },
  );

  app.get(
    '/v1/admin/tenants/:id/numbers',
    { schema: { params: TenantParams } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.TENANTS_READ);
      const tenantId = request.params.id;
      return inPlatform(services, staff, request, async (trx) => {
        const numbers = await trx
          .selectFrom('phone_numbers')
          .select([
            'id',
            'e164',
            'provider',
            'status',
            'number_type',
            'location_id',
            'created_at',
            'updated_at',
          ])
          .where('tenant_id', '=', tenantId)
          .orderBy('created_at')
          .execute();
        const orders = await trx
          .selectFrom('phone_orders')
          .select(['id', 'status', 'provider', 'created_at', 'updated_at'])
          .where('tenant_id', '=', tenantId)
          .orderBy('created_at', 'desc')
          .limit(10)
          .execute();
        const workflows = await trx
          .selectFrom('provisioning_workflows')
          .select([
            'id',
            'state',
            'blocking_reason',
            'manual_review_reason',
            'attempt',
            'updated_at',
          ])
          .where('tenant_id', '=', tenantId)
          .orderBy('created_at', 'desc')
          .limit(5)
          .execute();
        return {
          numbers: numbers.map((row) => ({
            id: row.id,
            e164: row.e164,
            provider: row.provider,
            status: row.status,
            number_type: row.number_type,
            location_id: row.location_id,
            created_at: iso(row.created_at),
          })),
          orders: orders.map((row) => ({
            id: row.id,
            status: row.status,
            provider: row.provider,
            created_at: iso(row.created_at),
          })),
          provisioning: workflows.map((row) => ({
            id: row.id,
            state: row.state,
            blocking_reason: row.blocking_reason,
            manual_review_reason: row.manual_review_reason,
            attempt: row.attempt,
            updated_at: iso(row.updated_at),
          })),
        };
      });
    },
  );

  app.post(
    '/v1/admin/tenants/:id/numbers/:number_id/status',
    { schema: { params: NumberParams, body: NumberStatusBody } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.PHONE_NUMBERS_MANAGE);
      const tenantId = request.params.id;
      const body = request.body;
      return inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
        const number = await trx
          .selectFrom('phone_numbers')
          .select(['id', 'status', 'e164'])
          .where('id', '=', request.params.number_id)
          .executeTakeFirst();
        if (number === undefined) {
          throw new ApiError('NOT_FOUND');
        }
        if (number.status === 'RELEASED') {
          throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'number_released' });
        }
        await trx
          .updateTable('phone_numbers')
          .set((eb) => ({
            status: body.status,
            version: eb('version', '+', 1),
            updated_at: services.now(),
          }))
          .where('id', '=', number.id)
          .execute();
        if (body.status !== 'ACTIVE') {
          await trx
            .updateTable('agent_phone_bindings')
            .set({ active: false })
            .where('phone_number_id', '=', number.id)
            .where('active', '=', true)
            .execute();
        }
        await writeAudit(trx, staffActor(staff, tenantId), requestMeta(request), {
          action: 'phone_number.status_changed',
          objectType: 'phone_number',
          objectId: number.id,
          actorLabel: staff.email,
          metadata: { from: number.status, to: body.status, reason: body.reason },
        });
        return { id: number.id, e164: number.e164, status: body.status };
      });
    },
  );

  app.get(
    '/v1/admin/tenants/:id/secrets',
    { schema: { params: TenantParams } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.SECRETS_MANAGE);
      const tenantId = request.params.id;
      return inPlatform(services, staff, request, async (trx) => {
        const rows = await trx
          .selectFrom('tenant_secret_refs')
          .select([
            'id',
            'kind',
            'provider',
            'status',
            'secret_version',
            'external_key_id',
            'subject_id',
            'expires_at',
            'activated_at',
            'revoked_at',
            'created_at',
          ])
          .where('tenant_id', '=', tenantId)
          .orderBy('created_at', 'desc')
          .limit(100)
          .execute();
        return {
          data: rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            provider: row.provider,
            status: row.status,
            secret_version: row.secret_version,
            external_key_id: row.external_key_id,
            subject_id: row.subject_id,
            expires_at: iso(row.expires_at),
            activated_at: iso(row.activated_at),
            revoked_at: iso(row.revoked_at),
            created_at: iso(row.created_at),
          })),
        };
      });
    },
  );

  app.post(
    '/v1/admin/tenants/:id/secrets/:secret_id/revoke',
    { schema: { params: SecretParams, body: RevokeBody } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.SECRETS_MANAGE);
      const tenantId = request.params.id;
      return inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
        const credential = await trx
          .selectFrom('tenant_secret_refs')
          .select(['id', 'kind', 'status'])
          .where('id', '=', request.params.secret_id)
          .executeTakeFirst();
        if (credential === undefined) {
          throw new ApiError('NOT_FOUND');
        }
        if (credential.status.toUpperCase() === 'REVOKED') {
          throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'already_revoked' });
        }
        const now = services.now();
        await trx
          .updateTable('tenant_secret_refs')
          .set({ status: 'REVOKED', revoked_at: now, updated_at: now })
          .where('id', '=', credential.id)
          .execute();
        await writeAudit(trx, staffActor(staff, tenantId), requestMeta(request), {
          action: 'secret.revoked',
          objectType: 'tenant_secret_ref',
          objectId: credential.id,
          actorLabel: staff.email,
          metadata: { kind: credential.kind, reason: request.body.reason },
        });
        return { id: credential.id, status: 'REVOKED' };
      });
    },
  );

  app.get(
    '/v1/admin/tenants/:id/support-sessions',
    { schema: { params: TenantParams } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.SUPPORT_SESSIONS_START);
      const tenantId = request.params.id;
      return inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
        const rows = await trx
          .selectFrom('support_access_grants')
          .leftJoin('users', 'users.id', 'support_access_grants.staff_user_id')
          .select([
            'support_access_grants.id',
            'support_access_grants.access_level',
            'support_access_grants.status',
            'support_access_grants.reason',
            'support_access_grants.incident_ref',
            'support_access_grants.starts_at',
            'support_access_grants.expires_at',
            'support_access_grants.revoked_at',
            'support_access_grants.created_at',
            'users.email',
          ])
          .where('support_access_grants.tenant_id', '=', tenantId)
          .orderBy('support_access_grants.created_at', 'desc')
          .limit(50)
          .execute();
        return {
          data: rows.map((row) => ({
            id: row.id,
            access_level: row.access_level,
            status: row.status,
            reason: row.reason,
            incident_ref: row.incident_ref,
            staff_email: row.email,
            starts_at: iso(row.starts_at),
            expires_at: iso(row.expires_at),
            revoked_at: iso(row.revoked_at),
            created_at: iso(row.created_at),
          })),
        };
      });
    },
  );

  app.post(
    '/v1/admin/tenants/:id/support-sessions',
    { schema: { params: TenantParams, body: SupportSessionBody } },
    async (request, reply) => {
      const staff = requireStaff(request.principal, PlatformPermission.SUPPORT_SESSIONS_START);
      const tenantId = request.params.id;
      const body = request.body;
      if (
        body.access_level === 'SENSITIVE' &&
        !staffHasPermission(staff.platformRole, PlatformPermission.SENSITIVE_CONTENT_READ)
      ) {
        throw new ApiError('FORBIDDEN', {
          required_permission: PlatformPermission.SENSITIVE_CONTENT_READ,
        });
      }
      const created = await inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
        await assertTenant(trx, tenantId);
        const now = services.now();
        const minutes = body.minutes ?? 60;
        const row = await trx
          .insertInto('support_access_grants')
          .values({
            tenant_id: tenantId,
            staff_user_id: staff.userId,
            access_level: body.access_level,
            status: 'ACTIVE',
            reason: body.reason,
            incident_ref: body.incident_ref ?? null,
            starts_at: now,
            expires_at: new Date(now.getTime() + minutes * 60_000),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, staffActor(staff, tenantId), requestMeta(request), {
          action: 'support_access.granted',
          objectType: 'support_access_grant',
          objectId: row.id,
          actorLabel: staff.email,
          supportGrantId: row.id,
          metadata: {
            access_level: body.access_level,
            minutes,
            reason: body.reason,
            incident_ref: body.incident_ref ?? null,
          },
        });
        return row;
      });
      return reply.code(201).send({
        id: created.id,
        access_level: created.access_level,
        status: created.status,
        starts_at: iso(created.starts_at),
        expires_at: iso(created.expires_at),
      });
    },
  );

  app.post(
    '/v1/admin/tenants/:id/support-sessions/:grant_id/revoke',
    { schema: { params: GrantParams } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.SUPPORT_SESSIONS_START);
      const tenantId = request.params.id;
      return inTenantAsStaff(services, staff, tenantId, request, async (trx) => {
        const grant = await trx
          .selectFrom('support_access_grants')
          .select(['id', 'status'])
          .where('id', '=', request.params.grant_id)
          .executeTakeFirst();
        if (grant === undefined) {
          throw new ApiError('NOT_FOUND');
        }
        if (grant.status !== 'ACTIVE') {
          throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'not_active' });
        }
        const now = services.now();
        await trx
          .updateTable('support_access_grants')
          .set({ status: 'REVOKED', revoked_at: now, updated_at: now })
          .where('id', '=', grant.id)
          .execute();
        await writeAudit(trx, staffActor(staff, tenantId), requestMeta(request), {
          action: 'support_access.revoked',
          objectType: 'support_access_grant',
          objectId: grant.id,
          actorLabel: staff.email,
          supportGrantId: grant.id,
        });
        return { id: grant.id, status: 'REVOKED' };
      });
    },
  );

  app.get('/v1/admin/usage', { schema: { querystring: DaysQuery } }, async (request) => {
    const staff = requireStaff(request.principal, PlatformPermission.STATS_READ);
    const days = request.query.days === undefined ? 30 : Number(request.query.days);
    const result = await inPlatform(services, staff, request, (trx) =>
      sql<{ metric: string; quantity: string; cost_usd_micros: string; tenants: string }>`
        select * from app.admin_platform_usage(${days}::integer)`.execute(trx),
    );
    return {
      days,
      data: result.rows.map((row) => ({
        metric: row.metric,
        quantity: Number(row.quantity),
        cost_usd_micros: Number(row.cost_usd_micros),
        tenants: Number(row.tenants),
      })),
    };
  });

  app.get('/v1/admin/revenue', { schema: { querystring: DaysQuery } }, async (request) => {
    const staff = requireStaff(request.principal, PlatformPermission.STATS_READ);
    const days = request.query.days === undefined ? 30 : Number(request.query.days);
    const result = await inPlatform(services, staff, request, (trx) =>
      sql<{
        currency: string;
        issued_documents: string;
        issued_total_minor: string;
        pending_documents: string;
        balance_minor: string;
      }>`select * from app.admin_platform_revenue(${days}::integer)`.execute(trx),
    );
    return {
      days,
      data: result.rows.map((row) => ({
        currency: row.currency,
        issued_documents: Number(row.issued_documents),
        issued_total_minor: Number(row.issued_total_minor),
        pending_documents: Number(row.pending_documents),
        balance_minor: Number(row.balance_minor),
      })),
    };
  });
};
