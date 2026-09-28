import { PageHeader } from '@velyric/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SectionTabs } from '@/components/common/navigation';
import { requirePermission } from '@/server/session';

export default async function BookingsLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'bookings:read');
  const t = await getTranslations('bookings');
  const base = `/app/${workspaceId}/bookings`;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      <SectionTabs
        label={t('tabs.label')}
        items={[
          { href: base, label: t('tabs.bookings'), exact: true },
          { href: `${base}/services`, label: t('tabs.services') },
          { href: `${base}/resources`, label: t('tabs.resources') },
          ...(permissions.has('waitlist:read')
            ? [{ href: `${base}/waitlist`, label: t('tabs.waitlist') }]
            : []),
        ]}
      />
      {children}
    </div>
  );
}
