import { PLATFORM_ROLE_PERMISSIONS, type PlatformPermission } from '@velyric/contracts';
import type { PlatformRole } from '@velyric/contracts';
import { withTenantTransaction, withUserTransaction } from '@velyric/db';
import type { FastifyRequest } from 'fastify';
import type { AppServices } from './app.js';
import { ApiError } from './errors.js';
import type { Trx } from './persistence.js';
import { requirePlatformPermission, requireUser, type Principal } from './principal.js';

export interface StaffActor {
  readonly userId: string;
  readonly authSubject: string;
  readonly email: string;
  readonly platformRole: PlatformRole;
}

export function requireStaff(
  principal: Principal | null,
  permission: PlatformPermission,
): StaffActor {
  const user = requirePlatformPermission(principal, permission);
  if (user.platformRole === null) {
    throw new ApiError('FORBIDDEN', { reason: 'not_platform_staff' });
  }
  return {
    userId: user.userId,
    authSubject: user.authSubject,
    email: user.email,
    platformRole: user.platformRole,
  };
}

export function requireAnyStaff(principal: Principal | null): StaffActor {
  const user = requireUser(principal);
  if (user.platformRole === null) {
    throw new ApiError('FORBIDDEN', { reason: 'not_platform_staff' });
  }
  return {
    userId: user.userId,
    authSubject: user.authSubject,
    email: user.email,
    platformRole: user.platformRole,
  };
}

export function staffPermissions(role: PlatformRole): readonly PlatformPermission[] {
  return PLATFORM_ROLE_PERMISSIONS[role];
}

export function staffHasPermission(role: PlatformRole, permission: PlatformPermission): boolean {
  return PLATFORM_ROLE_PERMISSIONS[role].includes(permission);
}

export function inPlatform<T>(
  services: AppServices,
  staff: StaffActor,
  request: FastifyRequest,
  fn: (trx: Trx) => Promise<T>,
): Promise<T> {
  return withUserTransaction(
    services.db,
    { authSubject: staff.authSubject, userId: staff.userId, traceId: request.traceId },
    fn,
  );
}

export function inTenantAsStaff<T>(
  services: AppServices,
  staff: StaffActor,
  tenantId: string,
  request: FastifyRequest,
  fn: (trx: Trx) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(
    services.db,
    {
      tenantId,
      actorType: 'SUPPORT_STAFF',
      actorId: staff.userId,
      userId: staff.userId,
      traceId: request.traceId,
    },
    fn,
  );
}

export function staffAuditActor(staff: StaffActor, tenantId: string) {
  return {
    tenantId,
    actorType: 'SUPPORT_STAFF' as const,
    actorId: staff.userId,
    role: null,
    locationScope: [] as readonly string[],
  };
}
