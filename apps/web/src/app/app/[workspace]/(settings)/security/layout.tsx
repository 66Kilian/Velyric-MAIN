import { PageHeader } from '@velyric/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SectionTabs } from '@/components/common/navigation';
import { requirePermission } from '@/server/session';

export default async function SecurityLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'security:read');
  const t = await getTranslations('security');
  const base = `/app/${workspaceId}/security`;
  const items = [
    ...(permissions.has('members:read')
      ? [{ href: base, label: t('tabs.members'), exact: true }]
      : []),
    { href: `${base}/roles`, label: t('tabs.roles') },
    ...(permissions.has('api_keys:manage')
      ? [{ href: `${base}/api-keys`, label: t('tabs.apiKeys') }]
      : []),
    ...(permissions.has('audit_logs:read')
      ? [{ href: `${base}/audit-log`, label: t('tabs.auditLog') }]
      : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      <SectionTabs label={t('tabs.label')} items={items} />
      {children}
    </div>
  );
}
