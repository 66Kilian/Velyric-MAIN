import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@velyric/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RetentionTable } from '@/components/settings/retention-table';
import type { RetentionPolicy } from '@/lib/api/settings';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.tabs');
  return { title: t('retention') };
}

export default async function RetentionSettingsPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'settings:read');
  const [t, policies] = await Promise.all([
    getTranslations('settings.retention'),
    serverGet<{ data: RetentionPolicy[] }>('/retention-policies', { workspace: workspaceId }),
  ]);
  const configurable = policies.data.filter((policy) => policy.tenant_configurable);
  const fixed = policies.data.filter((policy) => !policy.tenant_configurable);
  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>{t('configurableTitle')}</CardTitle>
          <CardDescription>{t('configurableDescription')}</CardDescription>
        </CardHeader>
        <RetentionTable
          workspaceId={workspaceId}
          policies={configurable}
          canManage={permissions.has('retention:manage')}
        />
      </Card>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>{t('fixedTitle')}</CardTitle>
          <CardDescription>{t('fixedDescription')}</CardDescription>
        </CardHeader>
        <RetentionTable workspaceId={workspaceId} policies={fixed} canManage={false} />
        <CardContent className="text-sm text-text-muted">{t('holdsNote')}</CardContent>
      </Card>
    </div>
  );
}
