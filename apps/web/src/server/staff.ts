import 'server-only';
import type { PlatformPermission, PlatformRole } from '@velyric/contracts';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { serverGet } from './api';

export interface StaffIdentity {
  readonly user_id: string;
  readonly email: string;
  readonly platform_role: PlatformRole;
  readonly permissions: readonly PlatformPermission[];
}

export interface StaffContext {
  readonly staff: StaffIdentity;
  readonly permissions: ReadonlySet<PlatformPermission>;
}

export const getStaffContext = cache(async (): Promise<StaffContext> => {
  try {
    const staff = await serverGet<StaffIdentity>('/admin/me');
    return { staff, permissions: new Set(staff.permissions) };
  } catch {
    notFound();
  }
});

export async function requireStaffPermission(
  permission: PlatformPermission,
): Promise<StaffContext> {
  const context = await getStaffContext();
  if (!context.permissions.has(permission)) {
    notFound();
  }
  return context;
}
