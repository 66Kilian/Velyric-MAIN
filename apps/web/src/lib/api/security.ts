import type { Role } from '@velyric/contracts';

export interface Member {
  readonly id: string;
  readonly user_id: string | null;
  readonly email: string | null;
  readonly display_name: string | null;
  readonly role: Role;
  readonly status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  readonly location_scope: readonly string[];
  readonly invitation_expires_at: string | null;
  readonly version: number;
  readonly created_at: string;
}

export interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  readonly created_by_user_id: string;
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

export interface AuditLogEntry {
  readonly id: string;
  readonly occurred_at: string;
  readonly actor: {
    readonly type: string;
    readonly id: string | null;
    readonly label: string | null;
    readonly name?: string | null;
    readonly email?: string | null;
  };
  readonly action: string;
  readonly object: { readonly type: string | null; readonly id: string | null };
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly diff_hash: string | null;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly trace_id: string | null;
  readonly support_grant_id: string | null;
}

export const NON_DELEGABLE_SCOPES: ReadonlySet<string> = new Set([
  'members:manage',
  'api_keys:manage',
  'security:manage',
  'support_access:grant',
  'billing:manage',
]);

export function permissionParts(permission: string): {
  readonly resource: string;
  readonly action: string;
} {
  const [resource = permission, action = ''] = permission.split(':');
  return { resource, action };
}
