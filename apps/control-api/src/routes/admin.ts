import { PlatformPermission } from '@velyric/contracts';
import { sql } from 'kysely';
import Type from 'typebox';
import { requestMeta, type RouteModule } from '../app.js';
import { ApiError } from '../errors.js';
import type { Trx } from '../persistence.js';
import {
  inPlatform,
  requireAnyStaff,
  requireStaff,
  staffPermissions,
  type StaffActor,
} from '../staff.js';
import { iso, Uuid } from './common.js';

const TenantQuery = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 120 })),
    status: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z_]{2,39}$' })),
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    offset: Type.Optional(Type.String({ pattern: '^[0-9]{1,6}$' })),
  },
  { additionalProperties: false },
);

const AuditQuery = Type.Object(
  {
    tenant_id: Type.Optional(Uuid),
    actor_type: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z_]{2,31}$' })),
    action: Type.Optional(Type.String({ pattern: '^[a-z][a-z_.]{0,60}$' })),
    before: Type.Optional(Type.String({ format: 'date-time' })),
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
  },
  { additionalProperties: false },
);

const LookupQuery = Type.Object(
  { email: Type.String({ format: 'email', maxLength: 254 }) },
  { additionalProperties: false },
);

const StaffParams = Type.Object({ user_id: Uuid }, { additionalProperties: false });

const StaffBody = Type.Object(
  {
    platform_role: Type.Union([
      Type.Literal('SUPPORT_AGENT'),
      Type.Literal('SUPPORT_LEAD'),
      Type.Literal('PLATFORM_OPS'),
      Type.Literal('FINANCE_OPS'),
      Type.Literal('PLATFORM_ADMIN'),
    ]),
    active: Type.Boolean(),
    reason: Type.String({ minLength: 10, maxLength: 500 }),
  },
  { additionalProperties: false },
);

interface TenantRow {
  readonly id: string;
  readonly display_name: string;
  readonly legal_name: string;
  readonly slug: string;
  readonly status: string;
  readonly status_reason: string | null;
  readonly plan_code: string | null;
  readonly billing_market: string;
  readonly trust_tier: string;
  readonly default_locale: string;
  readonly created_at: Date;
  readonly member_count: string;
  readonly location_count: string;
  readonly phone_number_count: string;
  readonly total_rows: string;
}

interface OverviewRow {
  readonly id: string;
  readonly display_name: string;
  readonly legal_name: string;
  readonly slug: string;
  readonly status: string;
  readonly status_reason: string | null;
  readonly status_changed_at: Date;
  readonly plan_code: string | null;
  readonly billing_market: string;
  readonly trust_tier: string;
  readonly vertical_pack: string;
  readonly default_locale: string;
  readonly timezone: string;
  readonly created_at: Date;
  readonly owner_email: string | null;
  readonly member_count: string;
  readonly location_count: string;
  readonly agent_count: string;
  readonly phone_numbers: { id: string; e164: string; status: string; provider: string }[];
  readonly provisioning_state: string | null;
  readonly subscription_status: string | null;
  readonly subscription_period_end: Date | null;
  readonly published_agent_count: string;
}

interface AuditRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly tenant_display_name: string | null;
  readonly occurred_at: Date;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly actor_label: string | null;
  readonly action: string;
  readonly object_type: string;
  readonly object_id: string | null;
  readonly metadata: Record<string, unknown>;
  readonly support_grant_id: string | null;
  readonly trace_id: string | null;
}

interface StaffRow {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly platform_role: string;
  readonly active: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface StatsRow {
  readonly tenants_total: string;
  readonly tenants_active: string;
  readonly tenants_provisioning: string;
  readonly tenants_suspended: string;
  readonly tenants_new_30d: string;
  readonly phone_numbers_active: string;
  readonly staff_active: string;
}

function count(value: string | null): number {
  return value === null ? 0 : Number(value);
}

function presentStaff(row: StaffRow): Record<string, unknown> {
  return {
    user_id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    platform_role: row.platform_role,
    active: row.active,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

async function staffRows(trx: Trx): Promise<readonly StaffRow[]> {
  const result = await sql<StaffRow>`select * from app.admin_staff_list()`.execute(trx);
  return result.rows;
}

function identity(staff: StaffActor): Record<string, unknown> {
  return {
    user_id: staff.userId,
    email: staff.email,
    platform_role: staff.platformRole,
    permissions: staffPermissions(staff.platformRole),
  };
}

export const registerAdminRoutes: RouteModule = (app, services) => {
  app.get('/v1/admin/me', (request) => identity(requireAnyStaff(request.principal)));

  app.get('/v1/admin/stats', async (request) => {
    const staff = requireStaff(request.principal, PlatformPermission.STATS_READ);
    const result = await inPlatform(services, staff, request, async (trx) => ({
      stats: await sql<StatsRow>`select * from app.admin_platform_stats()`.execute(trx),
      breakdown: await sql<{ status: string; total: string }>`
        select * from app.admin_tenant_status_breakdown()`.execute(trx),
      signups: await sql<{ bucket_start: Date; tenants: string; active: string }>`
        select * from app.admin_signup_trend(12::integer)`.execute(trx),
      tickets: await sql<{ bucket_start: Date; opened: string; closed: string }>`
        select * from app.admin_ticket_trend(12::integer)`.execute(trx),
    }));
    const row = result.stats.rows[0];
    if (row === undefined) {
      throw new ApiError('NOT_FOUND');
    }
    return {
      by_status: result.breakdown.rows.map((entry) => ({
        status: entry.status,
        total: count(entry.total),
      })),
      signup_trend: result.signups.rows.map((entry) => ({
        week: iso(entry.bucket_start),
        tenants: count(entry.tenants),
        active: count(entry.active),
      })),
      ticket_trend: result.tickets.rows.map((entry) => ({
        week: iso(entry.bucket_start),
        opened: count(entry.opened),
        closed: count(entry.closed),
      })),
      tenants: {
        total: count(row.tenants_total),
        active: count(row.tenants_active),
        provisioning: count(row.tenants_provisioning),
        suspended: count(row.tenants_suspended),
        new_30d: count(row.tenants_new_30d),
      },
      phone_numbers_active: count(row.phone_numbers_active),
      staff_active: count(row.staff_active),
    };
  });

  app.get('/v1/admin/tenants', { schema: { querystring: TenantQuery } }, async (request) => {
    const staff = requireStaff(request.principal, PlatformPermission.TENANTS_SEARCH);
    const limit = request.query.limit === undefined ? 25 : Number(request.query.limit);
    const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
    const result = await inPlatform(services, staff, request, (trx) =>
      sql<TenantRow>`select * from app.admin_tenants_page(
        ${request.query.query ?? null},
        ${request.query.status ?? null},
        ${limit}::integer,
        ${offset}::integer)`.execute(trx),
    );
    return {
      data: result.rows.map((row) => ({
        id: row.id,
        display_name: row.display_name,
        legal_name: row.legal_name,
        slug: row.slug,
        status: row.status,
        status_reason: row.status_reason,
        plan_code: row.plan_code,
        billing_market: row.billing_market,
        trust_tier: row.trust_tier,
        default_locale: row.default_locale,
        created_at: iso(row.created_at),
        member_count: count(row.member_count),
        location_count: count(row.location_count),
        phone_number_count: count(row.phone_number_count),
      })),
      total: count(result.rows[0]?.total_rows ?? null),
      limit,
      offset,
    };
  });

  app.get(
    '/v1/admin/tenants/:id',
    { schema: { params: Type.Object({ id: Uuid }, { additionalProperties: false }) } },
    async (request) => {
      const staff = requireStaff(request.principal, PlatformPermission.TENANTS_READ);
      const result = await inPlatform(services, staff, request, (trx) =>
        sql<OverviewRow>`select * from app.admin_tenant_overview(${request.params.id}::uuid)`.execute(
          trx,
        ),
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ApiError('NOT_FOUND');
      }
      return {
        id: row.id,
        display_name: row.display_name,
        legal_name: row.legal_name,
        slug: row.slug,
        status: row.status,
        status_reason: row.status_reason,
        status_changed_at: iso(row.status_changed_at),
        plan_code: row.plan_code,
        billing_market: row.billing_market,
        trust_tier: row.trust_tier,
        vertical_pack: row.vertical_pack,
        default_locale: row.default_locale,
        timezone: row.timezone,
        created_at: iso(row.created_at),
        owner_email: row.owner_email,
        member_count: count(row.member_count),
        location_count: count(row.location_count),
        agent_count: count(row.agent_count),
        phone_numbers: row.phone_numbers,
        provisioning_state: row.provisioning_state,
        subscription_status: row.subscription_status,
        subscription_period_end: iso(row.subscription_period_end),
        published_agent_count: count(row.published_agent_count),
      };
    },
  );

  app.get('/v1/admin/audit-logs', { schema: { querystring: AuditQuery } }, async (request) => {
    const staff = requireStaff(request.principal, PlatformPermission.AUDIT_READ);
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    const result = await inPlatform(services, staff, request, (trx) =>
      sql<AuditRow>`select * from app.admin_audit_feed(
        ${request.query.tenant_id ?? null},
        ${request.query.actor_type ?? null},
        ${request.query.action ?? null},
        ${request.query.before ?? null},
        ${limit}::integer)`.execute(trx),
    );
    return {
      data: result.rows.map((row) => ({
        id: row.id,
        tenant_id: row.tenant_id,
        workspace_name: row.tenant_display_name,
        occurred_at: iso(row.occurred_at),
        actor: {
          type: row.actor_type,
          id: row.actor_id,
          label: row.actor_label,
        },
        action: row.action,
        object_type: row.object_type,
        object_id: row.object_id,
        metadata: row.metadata,
        support_grant_id: row.support_grant_id,
        trace_id: row.trace_id,
      })),
    };
  });

  app.get('/v1/admin/staff', async (request) => {
    const staff = requireStaff(request.principal, PlatformPermission.STAFF_MANAGE);
    const rows = await inPlatform(services, staff, request, staffRows);
    return { data: rows.map(presentStaff) };
  });

  app.get('/v1/admin/staff/lookup', { schema: { querystring: LookupQuery } }, async (request) => {
    const staff = requireStaff(request.principal, PlatformPermission.STAFF_MANAGE);
    const email = request.query.email.trim().toLowerCase();
    const result = await inPlatform(services, staff, request, (trx) =>
      sql<{
        user_id: string;
        email: string;
        display_name: string | null;
        platform_role: string | null;
        active: boolean | null;
      }>`select * from app.admin_user_by_email(${email}::citext)`.execute(trx),
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApiError('NOT_FOUND');
    }
    return {
      user_id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      platform_role: row.platform_role,
      active: row.active ?? false,
    };
  });

  app.put(
    '/v1/admin/staff/:user_id',
    { schema: { params: StaffParams, body: StaffBody } },
    async (request, reply) => {
      const staff = requireStaff(request.principal, PlatformPermission.STAFF_MANAGE);
      if (staff.platformRole !== 'PLATFORM_ADMIN') {
        throw new ApiError('FORBIDDEN', { reason: 'platform_admin_required' });
      }
      if (request.params.user_id === staff.userId) {
        throw new ApiError('FORBIDDEN', { reason: 'cannot_change_own_role' });
      }
      const body = request.body;
      const rows = await inPlatform(services, staff, request, async (trx) => {
        await sql`select * from app.set_platform_staff(
          ${request.params.user_id}::uuid,
          ${body.platform_role},
          ${body.active},
          ${body.reason},
          ${requestMeta(request).traceId})`.execute(trx);
        return staffRows(trx);
      });
      const updated = rows.find((row) => row.user_id === request.params.user_id);
      if (updated === undefined) {
        throw new ApiError('NOT_FOUND');
      }
      return reply.code(200).send(presentStaff(updated));
    },
  );
};
