import { Permission, PlatformPermission } from './enums.js';
import type { PlatformRole, Role } from './enums.js';

const P = Permission;
const PP = PlatformPermission;

const ALL_WORKSPACE_PERMISSIONS: readonly Permission[] = Object.freeze(Object.values(Permission));
const ALL_PLATFORM_PERMISSIONS: readonly PlatformPermission[] = Object.freeze(
  Object.values(PlatformPermission),
);

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  OWNER: ALL_WORKSPACE_PERMISSIONS,
  ADMIN: Object.freeze([
    P.SUPPORT_TICKETS_READ,
    P.SUPPORT_TICKETS_WRITE,
    P.WORKSPACE_READ,
    P.WORKSPACE_UPDATE,
    P.MEMBERS_READ,
    P.LOCATIONS_READ,
    P.LOCATIONS_MANAGE,
    P.AGENTS_READ,
    P.AGENTS_WRITE,
    P.AGENT_VERSIONS_PUBLISH,
    P.AGENT_VERSIONS_ROLLBACK,
    P.CALLS_READ,
    P.CALLS_READ_TRANSCRIPT,
    P.CALLS_READ_RECORDING,
    P.CALLS_MONITOR_LIVE,
    P.CALLS_TRANSFER,
    P.CALLS_TERMINATE,
    P.CONTACTS_READ,
    P.CONTACTS_WRITE,
    P.CONTACTS_EXPORT,
    P.CONTACTS_DELETE,
    P.KNOWLEDGE_READ,
    P.KNOWLEDGE_WRITE,
    P.BOOKINGS_READ,
    P.BOOKINGS_WRITE,
    P.WAITLIST_READ,
    P.WAITLIST_WRITE,
    P.INTEGRATIONS_READ,
    P.INTEGRATIONS_MANAGE,
    P.CUSTOM_TOOLS_MANAGE,
    P.WEBHOOKS_MANAGE,
    P.API_KEYS_MANAGE,
    P.ANALYTICS_READ,
    P.QUALITY_READ,
    P.SIMULATIONS_READ,
    P.SIMULATIONS_RUN,
    P.PHONE_NUMBERS_READ,
    P.PHONE_NUMBERS_ORDER,
    P.PHONE_NUMBERS_MANAGE,
    P.BILLING_READ,
    P.PROVISIONING_READ,
    P.SETTINGS_READ,
    P.SETTINGS_MANAGE,
    P.PRIVACY_REQUESTS_MANAGE,
    P.NOTIFICATIONS_MANAGE,
    P.SECURITY_READ,
    P.AUDIT_LOGS_READ,
  ]),
  OPERATOR: Object.freeze([
    P.WORKSPACE_READ,
    P.LOCATIONS_READ,
    P.AGENTS_READ,
    P.CALLS_READ,
    P.CALLS_READ_TRANSCRIPT,
    P.CALLS_MONITOR_LIVE,
    P.CALLS_TRANSFER,
    P.CALLS_TERMINATE,
    P.CONTACTS_READ,
    P.CONTACTS_WRITE,
    P.KNOWLEDGE_READ,
    P.BOOKINGS_READ,
    P.BOOKINGS_WRITE,
    P.WAITLIST_READ,
    P.WAITLIST_WRITE,
    P.PHONE_NUMBERS_READ,
    P.SETTINGS_READ,
  ]),
  ANALYST: Object.freeze([
    P.WORKSPACE_READ,
    P.LOCATIONS_READ,
    P.AGENTS_READ,
    P.CALLS_READ,
    P.KNOWLEDGE_READ,
    P.BOOKINGS_READ,
    P.ANALYTICS_READ,
    P.QUALITY_READ,
    P.SIMULATIONS_READ,
    P.PHONE_NUMBERS_READ,
  ]),
  DEVELOPER: Object.freeze([
    P.WORKSPACE_READ,
    P.LOCATIONS_READ,
    P.AGENTS_READ,
    P.CALLS_READ,
    P.KNOWLEDGE_READ,
    P.INTEGRATIONS_READ,
    P.INTEGRATIONS_MANAGE,
    P.CUSTOM_TOOLS_MANAGE,
    P.WEBHOOKS_MANAGE,
    P.API_KEYS_MANAGE,
    P.SUPPORT_TICKETS_READ,
    P.SUPPORT_TICKETS_WRITE,
    P.SIMULATIONS_READ,
    P.SIMULATIONS_RUN,
    P.PHONE_NUMBERS_READ,
  ]),
  BILLING: Object.freeze([
    P.SUPPORT_TICKETS_READ,
    P.SUPPORT_TICKETS_WRITE,
    P.WORKSPACE_READ,
    P.LOCATIONS_READ,
    P.BILLING_READ,
    P.BILLING_MANAGE,
    P.INVOICES_READ,
    P.PROVISIONING_READ,
    P.PHONE_NUMBERS_READ,
  ]),
  VIEWER: Object.freeze([
    P.WORKSPACE_READ,
    P.LOCATIONS_READ,
    P.AGENTS_READ,
    P.CALLS_READ,
    P.KNOWLEDGE_READ,
    P.BOOKINGS_READ,
    P.ANALYTICS_READ,
    P.PHONE_NUMBERS_READ,
    P.SETTINGS_READ,
  ]),
});

export const LOCATION_SCOPABLE_ROLES: readonly Role[] = Object.freeze(['OPERATOR', 'VIEWER']);

export const PLATFORM_ROLE_PERMISSIONS: Readonly<
  Record<PlatformRole, readonly PlatformPermission[]>
> = Object.freeze({
  SUPPORT_AGENT: Object.freeze([
    PP.TENANTS_SEARCH,
    PP.TENANTS_READ,
    PP.SUPPORT_SESSIONS_START,
    PP.WEBHOOKS_REPLAY,
    PP.SYNC_RETRY,
    PP.EMAIL_RESEND,
    PP.KNOWLEDGE_REINDEX,
    PP.AUDIT_READ,
    PP.TICKETS_READ,
    PP.TICKETS_MANAGE,
    PP.STATS_READ,
  ]),
  SUPPORT_LEAD: Object.freeze([
    PP.TENANTS_SEARCH,
    PP.TENANTS_READ,
    PP.TENANTS_WRITE,
    PP.TENANTS_SUSPEND,
    PP.SUPPORT_SESSIONS_START,
    PP.SENSITIVE_CONTENT_READ,
    PP.CALLS_TERMINATE,
    PP.WEBHOOKS_REPLAY,
    PP.SYNC_RETRY,
    PP.EMAIL_RESEND,
    PP.KNOWLEDGE_REINDEX,
    PP.PROVISIONING_MANAGE,
    PP.PHONE_NUMBERS_MANAGE,
    PP.CONFIG_ROLLBACK,
    PP.AUDIT_READ,
    PP.TICKETS_READ,
    PP.TICKETS_MANAGE,
    PP.STATS_READ,
  ]),
  PLATFORM_OPS: Object.freeze([
    PP.TENANTS_SEARCH,
    PP.TENANTS_READ,
    PP.TENANTS_WRITE,
    PP.TENANTS_SUSPEND,
    PP.CALLS_TERMINATE,
    PP.WEBHOOKS_REPLAY,
    PP.SYNC_RETRY,
    PP.FEATURE_FLAGS_MANAGE,
    PP.KILL_SWITCHES_MANAGE,
    PP.PROVIDER_ROUTING_MANAGE,
    PP.PROVISIONING_MANAGE,
    PP.PHONE_NUMBERS_MANAGE,
    PP.SECRETS_MANAGE,
    PP.USAGE_MANAGE,
    PP.CONFIG_ROLLBACK,
    PP.AUDIT_READ,
    PP.TICKETS_READ,
    PP.STATS_READ,
  ]),
  FINANCE_OPS: Object.freeze([
    PP.TENANTS_SEARCH,
    PP.TENANTS_READ,
    PP.PROVISIONING_MANAGE,
    PP.REFUNDS_APPROVE,
    PP.BILLING_MANAGE,
    PP.BALANCE_MANAGE,
    PP.USAGE_MANAGE,
    PP.AUDIT_READ,
    PP.TICKETS_READ,
    PP.STATS_READ,
  ]),
  PLATFORM_ADMIN: ALL_PLATFORM_PERMISSIONS,
});

export const PLATFORM_PERMISSIONS_REQUIRING_SUPPORT_GRANT: readonly PlatformPermission[] =
  Object.freeze([PP.SENSITIVE_CONTENT_READ]);

export const STAFF_WORKSPACE_DENIED_PERMISSIONS: readonly Permission[] = Object.freeze([
  P.WORKSPACE_CANCEL,
  P.SUPPORT_ACCESS_GRANT,
]);

export function staffWorkspaceRole(platformRole: PlatformRole): Role | null {
  const granted = PLATFORM_ROLE_PERMISSIONS[platformRole];
  if (granted.includes(PP.TENANTS_WRITE)) {
    return 'OWNER';
  }
  if (granted.includes(PP.TENANTS_READ)) {
    return 'VIEWER';
  }
  return null;
}

export function staffWorkspacePermissions(platformRole: PlatformRole): readonly Permission[] {
  const role = staffWorkspaceRole(platformRole);
  if (role === null) {
    return Object.freeze([]);
  }
  return Object.freeze(
    ROLE_PERMISSIONS[role].filter(
      (permission) => !STAFF_WORKSPACE_DENIED_PERMISSIONS.includes(permission),
    ),
  );
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function platformRoleHasPermission(
  role: PlatformRole,
  permission: PlatformPermission,
): boolean {
  return PLATFORM_ROLE_PERMISSIONS[role].includes(permission);
}
