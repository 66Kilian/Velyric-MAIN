import { PageHeader } from '@velyric/ui';
import { getTranslations } from 'next-intl/server';
import { TicketConsole } from '@/components/support/ticket-console';
import type { SupportTicketSummary } from '@/lib/api/support';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';

export default async function SupportPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const context = await requirePermission(workspace, 'support_tickets:read');
  const [t, tickets] = await Promise.all([
    getTranslations('support'),
    serverGet<{ data: SupportTicketSummary[] }>('/support-tickets', { workspace }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      <TicketConsole
        workspaceId={workspace}
        initialTickets={tickets.data}
        canWrite={context.permissions.has('support_tickets:write')}
      />
    </div>
  );
}
