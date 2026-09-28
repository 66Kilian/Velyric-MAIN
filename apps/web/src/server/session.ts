import 'server-only';
import {
  PlatformRole,
  ROLE_PERMISSIONS,
  staffWorkspacePermissions,
  staffWorkspaceRole,
  type Permission,
  type Role,
} from '@velyric/contracts';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import type { AdminTenantDetail } from '@/lib/api/admin';
import { ApiRequestError } from '@/lib/api-types';
import { serverGet, serverGetOrNull } from './api';

export interface MeWorkspace {
  readonly id: string;
  readonly display_name: string;
  readonly slug: string;
  readonly status: string;
  readonly default_locale: string;
  readonly role: Role;
  readonly location_scope: readonly string[];
}

export interface MeInvitation {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_name: string;
  readonly role: string;
  readonly expires_at: string | null;
}

export interface Me {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly platform_role: string | null;
  };
  readonly workspaces: readonly MeWorkspace[];
  readonly invitations: readonly MeInvitation[];
}

export const getMe = cache(async (): Promise<Me> => {
  try {
    return await serverGet<Me>('/me');
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      (error.status === 401 || error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED')
    ) {
      redirect('/en/login?return_to=/app');
    }
    throw error;
  }
});

export interface WorkspaceContext {
  readonly me: Me;
  readonly workspace: MeWorkspace;
  readonly permissions: ReadonlySet<Permission>;
  readonly staffMode: boolean;
}

function platformRoleOf(value: string | null): PlatformRole | null {
  return value !== null && (Object.values(PlatformRole) as string[]).includes(value)
    ? (value as PlatformRole)
    : null;
}

export const getWorkspaceContext = cache(async (workspaceId: string): Promise<WorkspaceContext> => {
  const me = await getMe();
  const workspace = me.workspaces.find((candidate) => candidate.id === workspaceId);
  if (workspace !== undefined) {
    return {
      me,
      workspace,
      permissions: new Set(ROLE_PERMISSIONS[workspace.role]),
      staffMode: false,
    };
  }
  const platformRole = platformRoleOf(me.user.platform_role);
  const staffRole = platformRole === null ? null : staffWorkspaceRole(platformRole);
  if (platformRole !== null && staffRole !== null) {
    const tenant = await serverGetOrNull<AdminTenantDetail>(`/admin/tenants/${workspaceId}`);
    if (tenant !== null) {
      return {
        me,
        workspace: {
          id: tenant.id,
          display_name: tenant.display_name,
          slug: tenant.slug,
          status: tenant.status,
          default_locale: tenant.default_locale,
          role: staffRole,
          location_scope: [],
        },
        permissions: new Set(staffWorkspacePermissions(platformRole)),
        staffMode: true,
      };
    }
  }
  notFound();
});

export async function requirePermission(
  workspaceId: string,
  permission: Permission,
): Promise<WorkspaceContext> {
  const context = await getWorkspaceContext(workspaceId);
  if (!context.permissions.has(permission)) {
    notFound();
  }
  return context;
}
