import { Card, CardContent, PageHeader } from '@velyric/ui';
import { getTranslations } from 'next-intl/server';
import { StaffManager } from '@/components/admin/staff-manager';
import type { AdminStaffRow } from '@/lib/api/admin';
import { serverGet } from '@/server/api';
import { getStaffContext, requireStaffPermission } from '@/server/staff';

export default async function AdminStaffPage() {
  await requireStaffPermission('platform.staff:manage');
  const { staff } = await getStaffContext();
  const [t, rows] = await Promise.all([
    getTranslations('admin.staff'),
    serverGet<{ data: AdminStaffRow[] }>('/admin/staff'),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      <Card>
        <CardContent className="pt-5">
          <StaffManager
            rows={rows.data}
            currentUserId={staff.user_id}
            canEdit={staff.platform_role === 'PLATFORM_ADMIN'}
          />
        </CardContent>
      </Card>
    </div>
  );
}
