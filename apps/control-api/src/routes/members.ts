import { createHash } from 'node:crypto';
import { ROLE_PERMISSIONS, type Role } from '@velyric/contracts';
import { withTenantTransaction, withUserTransaction } from '@velyric/db';
import { sql } from 'kysely';
import Type from 'typebox';
import {
  idempotentWrite,
  inTenant,
  requestMeta,
  requireIfMatch,
  tenantContext,
  weakEtag,
  type RouteModule,
} from '../app.js';
import { ApiError } from '../errors.js';
import { appendOutbox, newId, writeAudit, type Trx } from '../persistence.js';
import { requireTenantActor, requireUser, type TenantActor } from '../principal.js';
import { domainSubject, IdParams, iso, Uuid } from './common.js';

export interface MemberRouteDependencies {
  readonly webOrigin: string;
}

const INVITATION_TTL_DAYS = 7;
const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];
const PRIVILEGED_ROLES: ReadonlySet<Role> = new Set(['OWNER', 'ADMIN']);
const ROLE_LABELS: Readonly<Record<Role, string>> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  OPERATOR: 'Operator',
  ANALYST: 'Analyst',
  DEVELOPER: 'Developer',
  BILLING: 'Billing',
  VIEWER: 'Viewer',
};

const RoleSchema = Type.Enum(ROLES);
const LocationScope = Type.Array(Uuid, { maxItems: 50, uniqueItems: true });

const InviteBody = Type.Object(
  {
    email: Type.String({ format: 'email', maxLength: 254 }),
    role: RoleSchema,
    location_scope: Type.Optional(LocationScope),
  },
  { additionalProperties: false },
);

const UpdateBody = Type.Object(
  {
    role: Type.Optional(RoleSchema),
    location_scope: Type.Optional(LocationScope),
    status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('SUSPENDED')])),
  },
  { additionalProperties: false, minProperties: 1 },
);

const AcceptParams = Type.Object({ tenant_id: Uuid, id: Uuid }, { additionalProperties: false });

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}

function canAssign(actor: TenantActor, role: Role): boolean {
  if (actor.role === 'OWNER') {
    return true;
  }
  return actor.role === 'ADMIN' && !PRIVILEGED_ROLES.has(role);
}

async function assertLocations(trx: Trx, scope: readonly string[]): Promise<void> {
  if (scope.length === 0) {
    return;
  }
  const found = await trx
    .selectFrom('locations')
    .select(['id'])
    .where('id', 'in', [...scope])
    .execute();
  if (found.length !== scope.length) {
    throw new ApiError('VALIDATION_FAILED', {
      issues: [{ path: '/body/location_scope', rule: 'exists' }],
    });
  }
}

// memberships carries its own row policy: besides the current workspace it also
// exposes the caller's memberships in every other workspace, which is what /v1/me
// reads. Inside a tenant transaction that means every query here must name the
// tenant itself, or a membership from somewhere else leaks into the answer.
async function activeOwners(trx: Trx, tenantId: string): Promise<number> {
  const row = await trx
    .selectFrom('memberships')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('tenant_id', '=', tenantId)
    .where('role', '=', 'OWNER')
    .where('status', '=', 'ACTIVE')
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

interface MemberRow {
  readonly id: string;
  readonly role: string;
  readonly status: string;
  readonly location_scope: string[];
  readonly invited_email: string | null;
  readonly invitation_expires_at: Date | null;
  readonly user_id: string | null;
  readonly email: string | null;
  readonly display_name: string | null;
  readonly version: number;
  readonly created_at: Date;
}

function presentMember(row: MemberRow, actor: TenantActor): Record<string, unknown> {
  const privileged = actor.role !== null && PRIVILEGED_ROLES.has(actor.role);
  const email = row.email ?? row.invited_email;
  return {
    id: row.id,
    user_id: row.user_id,
    email:
      email === null ? null : privileged || row.user_id === actor.userId ? email : maskEmail(email),
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    location_scope: row.location_scope,
    invitation_expires_at: iso(row.invitation_expires_at),
    version: row.version,
    created_at: iso(row.created_at),
  };
}

function memberQuery(trx: Trx, tenantId: string) {
  return trx
    .selectFrom('memberships')
    .leftJoin('users', 'users.id', 'memberships.user_id')
    .where('memberships.tenant_id', '=', tenantId)
    .select([
      'memberships.id',
      'memberships.role',
      'memberships.status',
      'memberships.location_scope',
      'memberships.invited_email',
      'memberships.invitation_expires_at',
      'memberships.user_id',
      'memberships.version',
      'memberships.created_at',
      'users.email',
      'users.display_name',
    ]);
}

export function createMemberRoutes(deps: MemberRouteDependencies): RouteModule {
  return (app, services) => {
    app.get('/v1/members', async (request) => {
      const actor = requireTenantActor(request.principal, 'members:read');
      const rows = await inTenant(services, actor, request, (trx) =>
        memberQuery(trx, actor.tenantId)
          .where('memberships.status', '<>', 'REMOVED')
          .orderBy('memberships.created_at')
          .limit(500)
          .execute(),
      );
      return { data: rows.map((row) => presentMember(row, actor)) };
    });

    app.post(
      '/v1/members/invitations',
      { schema: { body: InviteBody } },
      async (request, reply) => {
        const user = requireUser(request.principal);
        const actor = requireTenantActor(request.principal, 'members:manage');
        const body = request.body;
        const email = body.email.trim().toLowerCase();
        if (!canAssign(actor, body.role)) {
          throw new ApiError('FORBIDDEN', { reason: 'role_above_actor' });
        }
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: user.userId },
          'members.invite',
          async (trx) => {
            await assertLocations(trx, body.location_scope ?? []);
            const existing = await trx
              .selectFrom('memberships')
              .leftJoin('users', 'users.id', 'memberships.user_id')
              .select(['memberships.id', 'memberships.status'])
              .where('memberships.tenant_id', '=', actor.tenantId)
              .where((eb) =>
                eb.or([
                  eb('memberships.invited_email', '=', email),
                  eb(sql`lower(users.email)`, '=', email),
                ]),
              )
              .forUpdate(['memberships'])
              .executeTakeFirst();
            if (
              existing !== undefined &&
              existing.status !== 'INVITED' &&
              existing.status !== 'REMOVED'
            ) {
              throw new ApiError('CONFLICT', { reason: 'already_a_member' });
            }
            const expiresAt = new Date(services.now().getTime() + INVITATION_TTL_DAYS * 86_400_000);
            const membershipId = existing?.id ?? newId();
            if (existing === undefined) {
              await trx
                .insertInto('memberships')
                .values({
                  id: membershipId,
                  tenant_id: actor.tenantId,
                  invited_email: email,
                  role: body.role,
                  location_scope: body.location_scope ?? [],
                  status: 'INVITED',
                  invited_by_user_id: user.userId,
                  invitation_expires_at: expiresAt,
                })
                .execute();
            } else {
              await trx
                .updateTable('memberships')
                .set((eb) => ({
                  user_id: null,
                  invited_email: email,
                  role: body.role,
                  location_scope: body.location_scope ?? [],
                  status: 'INVITED',
                  invited_by_user_id: user.userId,
                  invitation_expires_at: expiresAt,
                  version: eb('version', '+', 1),
                  updated_at: services.now(),
                }))
                .where('id', '=', membershipId)
                .execute();
            }
            const tenant = await trx
              .selectFrom('tenants')
              .select(['display_name', 'default_locale'])
              .where('id', '=', actor.tenantId)
              .executeTakeFirstOrThrow();
            const inviter = await trx
              .selectFrom('users')
              .select(['display_name', 'email'])
              .where('id', '=', user.userId)
              .executeTakeFirst();
            await appendOutbox(trx, {
              tenantId: actor.tenantId,
              eventType: 'notification.requested',
              subject: domainSubject(actor.tenantId, 'notification.requested'),
              payload: {
                notification_type: 'SECURITY_MEMBER_INVITED',
                dedupe_key: `invite:${membershipId}:${String(expiresAt.getTime())}`,
                recipient_membership_id: membershipId,
                template_payload: {
                  workspace_name: tenant.display_name,
                  inviter_name: inviter?.display_name ?? inviter?.email ?? 'Velyric',
                  role_label: ROLE_LABELS[body.role],
                  expires_at: expiresAt.toISOString().slice(0, 16).replace('T', ' '),
                  // The recipient may have no Velyric account yet, so the link
                  // lands on the public invitation page: it offers signing up
                  // or signing in and only then accepts the invitation.
                  accept_url: new URL(
                    `/${tenant.default_locale}/invite/${actor.tenantId}/${membershipId}`,
                    deps.webOrigin,
                  ).toString(),
                },
              },
              traceId: request.traceId,
            });
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'member.invited',
              objectType: 'membership',
              objectId: membershipId,
              metadata: {
                role: body.role,
                email_hash: createHash('sha256').update(email).digest('hex'),
                location_scope: body.location_scope ?? [],
              },
            });
            const row = await memberQuery(trx, actor.tenantId)
              .where('memberships.id', '=', membershipId)
              .executeTakeFirstOrThrow();
            return {
              status: 201,
              body: presentMember(row, actor),
              resource: { type: 'membership', id: membershipId },
            };
          },
        );
      },
    );

    app.patch(
      '/v1/members/:id',
      { schema: { params: IdParams, body: UpdateBody } },
      async (request, reply) => {
        const user = requireUser(request.principal);
        const actor = requireTenantActor(request.principal, 'members:manage');
        const expected = requireIfMatch(request);
        const body = request.body;
        return idempotentWrite(
          request,
          reply,
          services,
          tenantContext(actor, request),
          { tenantId: actor.tenantId, userId: user.userId },
          'members.update',
          async (trx) => {
            const member = await trx
              .selectFrom('memberships')
              .selectAll()
              .where('id', '=', request.params.id)
              .where('tenant_id', '=', actor.tenantId)
              .forUpdate()
              .executeTakeFirst();
            if (member === undefined || member.status === 'REMOVED') {
              throw new ApiError('NOT_FOUND');
            }
            if (member.version !== expected) {
              throw new ApiError('VERSION_CONFLICT', { current_version: member.version });
            }
            if (member.user_id === user.userId) {
              throw new ApiError('FORBIDDEN', { reason: 'cannot_modify_own_membership' });
            }
            const currentRole = member.role as Role;
            if (
              !canAssign(actor, currentRole) ||
              (body.role !== undefined && !canAssign(actor, body.role))
            ) {
              throw new ApiError('FORBIDDEN', { reason: 'role_above_actor' });
            }
            if (body.status === 'ACTIVE' && member.status === 'INVITED') {
              throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'invitation_not_accepted' });
            }
            const demotesOwner =
              currentRole === 'OWNER' &&
              member.status === 'ACTIVE' &&
              ((body.role !== undefined && body.role !== 'OWNER') || body.status === 'SUSPENDED');
            if (demotesOwner && (await activeOwners(trx, actor.tenantId)) <= 1) {
              throw new ApiError('CONFLICT', { reason: 'last_owner' });
            }
            await assertLocations(trx, body.location_scope ?? []);
            await trx
              .updateTable('memberships')
              .set((eb) => ({
                ...(body.role === undefined ? {} : { role: body.role }),
                ...(body.location_scope === undefined
                  ? {}
                  : { location_scope: body.location_scope }),
                ...(body.status === undefined ? {} : { status: body.status }),
                version: eb('version', '+', 1),
                updated_at: services.now(),
              }))
              .where('id', '=', member.id)
              .execute();
            if (body.role !== undefined && body.role !== currentRole && member.user_id !== null) {
              const tenant = await trx
                .selectFrom('tenants')
                .select(['display_name'])
                .where('id', '=', actor.tenantId)
                .executeTakeFirstOrThrow();
              const target = await trx
                .selectFrom('users')
                .select(['email'])
                .where('id', '=', member.user_id)
                .executeTakeFirst();
              const actorUser = await trx
                .selectFrom('users')
                .select(['display_name', 'email'])
                .where('id', '=', user.userId)
                .executeTakeFirst();
              await appendOutbox(trx, {
                tenantId: actor.tenantId,
                eventType: 'notification.requested',
                subject: domainSubject(actor.tenantId, 'notification.requested'),
                payload: {
                  notification_type: 'SECURITY_MEMBER_ROLE_CHANGED',
                  dedupe_key: `role:${member.id}:${String(member.version + 1)}`,
                  template_payload: {
                    workspace_name: tenant.display_name,
                    member_email: maskEmail(target?.email ?? 'member@unknown'),
                    role_label: ROLE_LABELS[body.role],
                    actor_name: actorUser?.display_name ?? actorUser?.email ?? 'Velyric',
                    action_url: new URL(
                      `/app/${actor.tenantId}/security`,
                      deps.webOrigin,
                    ).toString(),
                  },
                },
                traceId: request.traceId,
              });
            }
            await writeAudit(trx, actor, requestMeta(request), {
              action: 'member.updated',
              objectType: 'membership',
              objectId: member.id,
              diff: body,
              metadata: { from_role: currentRole, fields: Object.keys(body) },
            });
            const row = await memberQuery(trx, actor.tenantId)
              .where('memberships.id', '=', member.id)
              .executeTakeFirstOrThrow();
            return {
              status: 200,
              body: presentMember(row, actor),
              headers: { etag: weakEtag(row.version) },
            };
          },
        );
      },
    );

    app.delete('/v1/members/:id', { schema: { params: IdParams } }, async (request, reply) => {
      const user = requireUser(request.principal);
      const actor = requireTenantActor(request.principal, 'members:manage');
      return idempotentWrite(
        request,
        reply,
        services,
        tenantContext(actor, request),
        { tenantId: actor.tenantId, userId: user.userId },
        'members.remove',
        async (trx) => {
          const member = await trx
            .selectFrom('memberships')
            .selectAll()
            .where('id', '=', request.params.id)
            .where('tenant_id', '=', actor.tenantId)
            .forUpdate()
            .executeTakeFirst();
          if (member === undefined || member.status === 'REMOVED') {
            throw new ApiError('NOT_FOUND');
          }
          if (!canAssign(actor, member.role as Role)) {
            throw new ApiError('FORBIDDEN', { reason: 'role_above_actor' });
          }
          if (
            member.role === 'OWNER' &&
            member.status === 'ACTIVE' &&
            (await activeOwners(trx, actor.tenantId)) <= 1
          ) {
            throw new ApiError('CONFLICT', { reason: 'last_owner' });
          }
          await trx
            .updateTable('memberships')
            .set((eb) => ({
              status: 'REMOVED',
              invitation_expires_at: null,
              version: eb('version', '+', 1),
              updated_at: services.now(),
            }))
            .where('id', '=', member.id)
            .execute();
          await writeAudit(trx, actor, requestMeta(request), {
            action: 'member.removed',
            objectType: 'membership',
            objectId: member.id,
            metadata: { role: member.role, was_invitation: member.status === 'INVITED' },
          });
          return { status: 204, body: null };
        },
      );
    });

    app.get('/v1/invitations', async (request) => {
      const user = requireUser(request.principal);
      const rows = await withUserTransaction(
        services.db,
        { authSubject: user.authSubject, userId: user.userId, traceId: request.traceId },
        (trx) =>
          sql<{
            membership_id: string;
            tenant_id: string;
            tenant_display_name: string;
            role: string;
            invitation_expires_at: Date | null;
          }>`
          select * from app.pending_invitations_for_email(${user.email.trim().toLowerCase()}::citext)`.execute(
            trx,
          ),
      );
      return {
        data: rows.rows.map((row) => ({
          id: row.membership_id,
          tenant_id: row.tenant_id,
          workspace_name: row.tenant_display_name,
          role: row.role,
          expires_at: iso(row.invitation_expires_at),
        })),
      };
    });

    // Public: the invited address may not have an account yet, so the landing
    // page behind the emailed link has to render before anyone signs in. The
    // membership id is an unguessable uuid and only ever names the workspace.
    app.get(
      '/v1/invitations/:tenant_id/:id/preview',
      { schema: { params: AcceptParams } },
      async (request) => {
        const found = await sql<{
          membership_id: string;
          tenant_id: string;
          tenant_display_name: string;
          role: string;
          invitation_expires_at: Date | null;
          invited_email: string;
          has_account: boolean;
        }>`select * from app.invitation_link(${request.params.id}::uuid)`.execute(services.db);
        const row = found.rows[0];
        if (row === undefined || row.tenant_id !== request.params.tenant_id) {
          throw new ApiError('NOT_FOUND');
        }
        return {
          id: row.membership_id,
          tenant_id: row.tenant_id,
          workspace_name: row.tenant_display_name,
          role: row.role,
          expires_at: iso(row.invitation_expires_at),
          email: maskEmail(row.invited_email),
          has_account: row.has_account,
        };
      },
    );

    app.post(
      '/v1/invitations/:tenant_id/:id/accept',
      { schema: { params: AcceptParams } },
      async (request) => {
        const user = requireUser(request.principal);
        const context = {
          tenantId: request.params.tenant_id,
          actorType: 'USER' as const,
          actorId: user.userId,
          userId: user.userId,
          traceId: request.traceId,
        };
        return withTenantTransaction(services.db, context, async (trx) => {
          const invitation = await trx
            .selectFrom('memberships')
            .selectAll()
            .where('id', '=', request.params.id)
            .where('tenant_id', '=', request.params.tenant_id)
            .forUpdate()
            .executeTakeFirst();
          const email = user.email.trim().toLowerCase();
          if (
            invitation === undefined ||
            invitation.status !== 'INVITED' ||
            invitation.invited_email?.toLowerCase() !== email
          ) {
            throw new ApiError('NOT_FOUND');
          }
          if (
            invitation.invitation_expires_at !== null &&
            invitation.invitation_expires_at.getTime() <= services.now().getTime()
          ) {
            throw new ApiError('INVALID_STATE_TRANSITION', { reason: 'invitation_expired' });
          }
          const existing = await trx
            .selectFrom('memberships')
            .select(['id'])
            .where('tenant_id', '=', request.params.tenant_id)
            .where('user_id', '=', user.userId)
            .executeTakeFirst();
          if (existing !== undefined) {
            throw new ApiError('CONFLICT', { reason: 'already_a_member' });
          }
          await trx
            .updateTable('memberships')
            .set((eb) => ({
              user_id: user.userId,
              status: 'ACTIVE',
              invitation_expires_at: null,
              version: eb('version', '+', 1),
              updated_at: services.now(),
            }))
            .where('id', '=', invitation.id)
            .execute();
          await trx
            .insertInto('audit_logs')
            .values({
              id: newId(),
              tenant_id: request.params.tenant_id,
              actor_type: 'USER',
              actor_id: user.userId,
              action: 'member.invitation_accepted',
              object_type: 'membership',
              object_id: invitation.id,
              metadata: JSON.stringify({ role: invitation.role }),
              ip: request.ip === '' ? null : request.ip,
              trace_id: request.traceId,
            })
            .execute();
          return {
            tenant_id: request.params.tenant_id,
            membership_id: invitation.id,
            role: invitation.role,
            status: 'ACTIVE',
          };
        });
      },
    );
  };
}
