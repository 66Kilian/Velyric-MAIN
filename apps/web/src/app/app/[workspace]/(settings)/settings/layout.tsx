import { PageHeader } from '@velyric/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SectionTabs } from '@/components/common/navigation';
import { requirePermission } from '@/server/session';

export default async function SettingsLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'workspace:read');
  const t = await getTranslations('settings');
  const base = `/app/${workspaceId}/settings`;
  const items = [
    ...(permissions.has('settings:read')
      ? [{ href: base, label: t('tabs.general'), exact: true }]
      : []),
    { href: `${base}/notifications`, label: t('tabs.notifications') },
    ...(permissions.has('settings:read')
      ? [
          { href: `${base}/webhooks`, label: t('tabs.webhooks') },
          { href: `${base}/retention`, label: t('tabs.retention') },
        ]
      : []),
    ...(permissions.has('privacy_requests:manage')
      ? [{ href: `${base}/privacy`, label: t('tabs.privacy') }]
      : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('tabs.general')} description={t('description')} />
      <SectionTabs label={t('tabs.label')} items={items} />
      {children}
    </div>
  );
}
