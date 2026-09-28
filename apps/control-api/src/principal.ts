import {
  LOCATION_SCOPABLE_ROLES,
  PLATFORM_ROLE_PERMISSIONS,
  ROLE_PERMISSIONS,
  staffWorkspacePermissions,
  type ActorType,
  type Permission,
  type PlatformPermission,
  type PlatformRole,
  type Role,
  type ServiceName,
} from '@velyric/contracts';
import type { ServiceScope } from '@velyric/security';
import { ApiError } from './errors.js';

export interface UserPrincipal {
  readonly kind: 'user';
  readonly userId: string;
  readonly authSubject: string;
  readonly email: string;
  readonly sessionId: string;
  readonly platformRole: PlatformRole | null;
  readonly membership: {
    readonly tenantId: string;
    readonly role: Role;
    readonly locationScope: readonly string[];
    readonly viaPlatformRole?: true;
  } | null;
}

export interface ApiKeyPrincipal {
  readonly kind: 'api_key';
  readonly apiKeyId: string;
  readonly tenantId: string;
  readonly scopes: ReadonlySet<Permission>;
}

export interface ServicePrincipal {
  readonly kind: 'service';
  readonly issuer: ServiceName;
  readonly scopes: ReadonlySet<ServiceScope>;
  readonly tenantId: string | null;
}

export type Principal = UserPrincipal | ApiKeyPrincipal | ServicePrincipal;

export interface TenantActor {
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly userId?: string;
  readonly actorLabel?: string;
  readonly role: Role | null;
  readonly locationScope: readonly string[];
}

export function permissionsOf(principal: Principal): ReadonlySet<Permission> {
  switch (principal.kind) {
    case 'user':
      if (principal.membership === null) {
        return new Set();
      }
      return new Set(
        principal.membership.viaPlatformRole === true && principal.platformRole !== null
          ? staffWorkspacePermissions(principal.platformRole)
          : ROLE_PERMISSIONS[principal.membership.role],
      );
    case 'api_key':
      return principal.scopes;
    case 'service':
      return new Set();
  }
}

export function requireTenantActor(
  principal: Principal | null,
  permission: Permission,
  locationId?: string | null,
): TenantActor {
  if (principal === null) {
    throw new ApiError('UNAUTHENTICATED');
  }
  if (principal.kind === 'service') {
    throw new ApiError('FORBIDDEN');
  }
  if (!permissionsOf(principal).has(permission)) {
    throw new ApiError('FORBIDDEN', { required_permission: permission });
  }
  if (principal.kind === 'api_key') {
    return {
      tenantId: principal.tenantId,
      actorType: 'API_KEY',
      actorId: principal.apiKeyId,
      role: null,
      locationScope: [],
    };
  }
  const membership = principal.membership;
  if (membership === null) {
    throw new ApiError('FORBIDDEN', { reason: 'workspace_not_selected' });
  }
  const scoped =
    LOCATION_SCOPABLE_ROLES.includes(membership.role) && membership.locationScope.length > 0;
  if (
    scoped &&
    locationId !== undefined &&
    (locationId === null || !membership.locationScope.includes(locationId))
  ) {
    throw new ApiError('FORBIDDEN', { reason: 'location_scope' });
  }
  const viaPlatform = membership.viaPlatformRole === true;
  return {
    tenantId: membership.tenantId,
    actorType: viaPlatform ? 'SUPPORT_STAFF' : 'USER',
    actorId: principal.userId,
    userId: principal.userId,
    ...(viaPlatform ? { actorLabel: principal.email } : {}),
    role: membership.role,
    locationScope: scoped ? membership.locationScope : [],
  };
}

export function requireUser(principal: Principal | null): UserPrincipal {
  if (principal === null) {
    throw new ApiError('UNAUTHENTICATED');
  }
  if (principal.kind !== 'user') {
    throw new ApiError('FORBIDDEN');
  }
  return principal;
}

export function requirePlatformPermission(
  principal: Principal | null,
  permission: PlatformPermission,
): UserPrincipal {
  const user = requireUser(principal);
  if (
    user.platformRole === null ||
    !PLATFORM_ROLE_PERMISSIONS[user.platformRole].includes(permission)
  ) {
    throw new ApiError('FORBIDDEN', { required_permission: permission });
  }
  return user;
}

export function requireServiceScope(
  principal: Principal | null,
  scope: ServiceScope,
): ServicePrincipal {
  if (principal === null) {
    throw new ApiError('SERVICE_TOKEN_INVALID');
  }
  if (principal.kind !== 'service') {
    throw new ApiError('FORBIDDEN');
  }
  if (!principal.scopes.has(scope)) {
    throw new ApiError('SERVICE_SCOPE_MISSING', { required_scope: scope });
  }
  return principal;
}
