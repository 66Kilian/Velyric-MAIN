import { PageHeader } from '@velyric/ui';
import { getTranslations } from 'next-intl/server';
import { TicketQueue } from '@/components/admin/ticket-queue';
import type { AdminTicketSummary } from '@/lib/api/support';
import { serverGet } from '@/server/api';
import { getStaffContext, requireStaffPermission } from '@/server/staff';
import { searchValue } from '@/server/workspace';

export default async function AdminTicketsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStaffPermission('platform.tickets:read');
  const [{ staff, permissions }, search] = await Promise.all([getStaffContext(), searchParams]);
  const status = searchValue(search['status']);
  const [t, queue] = await Promise.all([
    getTranslations('admin.tickets'),
    serverGet<{ data: AdminTicketSummary[]; total: number }>('/admin/tickets', {
      query: { limit: 50, ...(status === undefined ? {} : { status }) },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description', { total: queue.total })} />
      <TicketQueue
        initialQueue={queue.data}
        staffUserId={staff.user_id}
        canManage={permissions.has('platform.tickets:manage')}
      />
    </div>
  );
}
