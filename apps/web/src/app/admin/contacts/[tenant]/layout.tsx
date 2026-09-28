import type { ReactNode } from 'react';
import { TenantScope } from '@/components/admin/tenant-scope';
import { requireStaffPermission } from '@/server/staff';

export default async function AdminContactsTenantLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ tenant: string }>;
}) {
  await requireStaffPermission('platform.tenants:read');
  const { tenant } = await params;
  return (
    <div className="flex flex-col gap-6">
      <TenantScope tenantId={tenant} section="contacts" />
      {children}
    </div>
  );
}
