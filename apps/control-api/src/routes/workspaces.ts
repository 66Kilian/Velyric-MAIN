import { LocaleSchema } from '@velyric/contracts';
import { ensureBuiltInTools, withUserTransaction } from '@velyric/db';
import { isValidTimeZone } from '@velyric/domain';
import { sql, type Selectable } from 'kysely';
import type { Tenants } from '@velyric/db';
import Type from 'typebox';
import {
  idempotentWrite,
  inTenant,
  requestMeta,
  requireIfMatch,
  weakEtag,
  type RouteModule,
} from '../app.js';
import { ApiError } from '../errors.js';
import { appendOutbox, newId, writeAudit } from '../persistence.js';
import { requireTenantActor, requireUser, type TenantActor } from '../principal.js';
import { domainSubject, IdParams, iso } from './common.js';

const TimeZone = Type.String({ minLength: 3, maxLength: 64 });

const CreateWorkspaceBody = Type.Object(
  {
    legal_name: Type.String({ minLength: 1, maxLength: 300 }),
    display_name: Type.String({ minLength: 1, maxLength: 120 }),
    slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' }),
    default_locale: LocaleSchema,
    timezone: TimeZone,
    billing_market: Type.Union([Type.Literal('HU'), Type.Literal('INTERNATIONAL')]),
    primary_location: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 160 }),
        country: Type.String({ pattern: '^[A-Z]{2}$' }),
        timezone: TimeZone,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const UpdateWorkspaceBody = Type.Object(
  {
    display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    default_locale: Type.Optional(LocaleSchema),
    timezone: Type.Optional(TimeZone),
  },
  { additionalProperties: false, minProperties: 1 },
);

export function presentWorkspace(row: Selectable<Tenants>): Record<string, unknown> {
  return {
    id: row.id,
    legal_name: row.legal_name,
    display_name: row.display_name,
    slug: row.slug,
    status: row.status,
    default_locale: row.default_locale,
    timezone: row.timezone,
    billing_market: row.billing_market,
    plan_code: row.plan_code,
    trust_tier: row.trust_tier,
    vertical_pack: row.vertical_pack,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function assertTimeZone(value: string | undefined, path: string): void {
  if (value !== undefined && !isValidTimeZone(value)) {
    throw new ApiError('VALIDATION_FAILED', { issues: [{ path, rule: 'iana_time_zone' }] });
  }
}

export const registerWorkspaceRoutes: RouteModule = (app, services) => {
  app.get('/v1/me', async (request) => {
    const user = requireUser(request.principal);
    const { workspaces, invitations } = await withUserTransaction(
      services.db,
      { authSubject: user.authSubject, userId: user.userId, traceId: request.traceId },
      async (trx) => ({
        workspaces: await trx
          .selectFrom('memberships')
          .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
          .select([
            'memberships.tenant_id',
            'memberships.role',
            'memberships.location_scope',
            'tenants.display_name',
            'tenants.slug',
            'tenants.status',
            'tenants.default_locale',
          ])
          .where('memberships.user_id', '=', user.userId)
          .where('memberships.status', '=', 'ACTIVE')
          .orderBy('tenants.display_name')
          .execute(),
        // Workspaces the user was invited to but has not joined yet, so the
        // workspace switcher can offer them right where they already look.
        invitations: await sql<{
          membership_id: string;
          tenant_id: string;
          tenant_display_name: string;
          role: string;
          invitation_expires_at: Date | null;
        }>`
          select * from app.pending_invitations_for_email(${user.email.trim().toLowerCase()}::citext)`.execute(
          trx,
        ),
      }),
    );
    return {
      user: { id: user.userId, email: user.email, platform_role: user.platformRole },
      workspaces: workspaces.map((row) => ({
        id: row.tenant_id,
        display_name: row.display_name,
        slug: row.slug,
        status: row.status,
        default_locale: row.default_locale,
        role: row.role,
        location_scope: row.location_scope,
      })),
      invitations: invitations.rows.map((row) => ({
        id: row.membership_id,
        tenant_id: row.tenant_id,
        workspace_name: row.tenant_display_name,
        role: row.role,
        expires_at: iso(row.invitation_expires_at),
      })),
    };
  });

  app.post('/v1/workspaces', { schema: { body: CreateWorkspaceBody } }, async (request, reply) => {
    const user = requireUser(request.principal);
    const body = request.body;
    assertTimeZone(body.timezone, '/body/timezone');
    assertTimeZone(body.primary_location.timezone, '/body/primary_location/timezone');
    const tenantId = newId();
    const actor: TenantActor = {
      tenantId,
      actorType: 'USER',
      actorId: user.userId,
      userId: user.userId,
      role: 'OWNER',
      locationScope: [],
    };
    return idempotentWrite(
      request,
      reply,
      services,
      {
        tenantId,
        actorType: 'USER',
        actorId: user.userId,
        userId: user.userId,
        traceId: request.traceId,
      },
      { tenantId: null, userId: user.userId },
      'workspaces.create',
      async (trx) => {
        await trx
          .insertInto('tenants')
          .values({
            id: tenantId,
            legal_name: body.legal_name,
            display_name: body.display_name,
            slug: body.slug,
            default_locale: body.default_locale,
            timezone: body.timezone,
            billing_market: body.billing_market,
            status: 'PROVISIONING',
          })
          .execute();
        await trx
          .insertInto('locations')
          .values({
            id: newId(),
            tenant_id: tenantId,
            name: body.primary_location.name,
            country: body.primary_location.country,
            timezone: body.primary_location.timezone,
            is_primary: true,
          })
          .execute();
        await trx
          .insertInto('memberships')
          .values({
            id: newId(),
            tenant_id: tenantId,
            user_id: user.userId,
            role: 'OWNER',
            status: 'ACTIVE',
          })
          .execute();
        await ensureBuiltInTools(trx, tenantId);
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'tenant.created',
          objectType: 'tenant',
          objectId: tenantId,
          diff: body,
        });
        await appendOutbox(trx, {
          tenantId,
          eventType: 'tenant.created',
          subject: domainSubject(tenantId, 'tenant.created'),
          payload: { tenant_id: tenantId, slug: body.slug, billing_market: body.billing_market },
          traceId: request.traceId,
        });
        const tenant = await trx
          .selectFrom('tenants')
          .selectAll()
          .where('id', '=', tenantId)
          .executeTakeFirstOrThrow();
        return {
          status: 201,
          body: presentWorkspace(tenant),
          resource: { type: 'tenant', id: tenantId },
          headers: { etag: weakEtag(tenant.version) },
        };
      },
    );
  });

  app.get('/v1/workspaces/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const actor = requireTenantActor(request.principal, 'workspace:read');
    if (request.params.id !== actor.tenantId) {
      throw new ApiError('NOT_FOUND');
    }
    const tenant = await inTenant(services, actor, request, (trx) =>
      trx.selectFrom('tenants').selectAll().where('id', '=', actor.tenantId).executeTakeFirst(),
    );
    if (tenant === undefined) {
      throw new ApiError('NOT_FOUND');
    }
    return reply.header('etag', weakEtag(tenant.version)).send(presentWorkspace(tenant));
  });

  app.patch(
    '/v1/workspaces/:id',
    { schema: { params: IdParams, body: UpdateWorkspaceBody } },
    async (request, reply) => {
      const actor = requireTenantActor(request.principal, 'workspace:update');
      if (request.params.id !== actor.tenantId) {
        throw new ApiError('NOT_FOUND');
      }
      const expectedVersion = requireIfMatch(request);
      assertTimeZone(request.body.timezone, '/body/timezone');
      const updated = await inTenant(services, actor, request, async (trx) => {
        const row = await trx
          .updateTable('tenants')
          .set((eb) => ({
            ...(request.body.display_name === undefined
              ? {}
              : { display_name: request.body.display_name }),
            ...(request.body.default_locale === undefined
              ? {}
              : { default_locale: request.body.default_locale }),
            ...(request.body.timezone === undefined ? {} : { timezone: request.body.timezone }),
            version: eb('version', '+', 1),
          }))
          .where('id', '=', actor.tenantId)
          .where('version', '=', expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) {
          const current = await trx
            .selectFrom('tenants')
            .select(['version'])
            .where('id', '=', actor.tenantId)
            .executeTakeFirst();
          throw current === undefined
            ? new ApiError('NOT_FOUND')
            : new ApiError('VERSION_CONFLICT', { current_version: current.version });
        }
        await writeAudit(trx, actor, requestMeta(request), {
          action: 'tenant.updated',
          objectType: 'tenant',
          objectId: actor.tenantId,
          diff: request.body,
        });
        return row;
      });
      return reply.header('etag', weakEtag(updated.version)).send(presentWorkspace(updated));
    },
  );
};
