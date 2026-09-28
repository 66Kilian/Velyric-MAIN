import { Badge, Card, CardContent, CardHeader, CardTitle, DescriptionList } from '@velyric/ui';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { WorkspaceSettingsForm } from '@/components/settings/workspace-settings-form';
import { getWorkspaceContext } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('settings') };
}

export default async function SettingsPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await getWorkspaceContext(workspaceId);
  if (!permissions.has('settings:read')) {
    redirect(`/app/${workspaceId}/settings/notifications`);
  }
  const [t, te, format, workspace] = await Promise.all([
    getTranslations('settings'),
    getTranslations('enums'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('general.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <WorkspaceSettingsForm
            workspace={workspace}
            timeZones={Intl.supportedValuesOf('timeZone')}
            canUpdate={permissions.has('workspace:update')}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('account.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DescriptionList
            items={[
              {
                term: t('account.status'),
                description: (
                  <Badge tone={workspace.status === 'ACTIVE' ? 'success' : 'warning'}>
                    {te.has(`tenantStatus.${workspace.status}`)
                      ? te(`tenantStatus.${workspace.status}`)
                      : workspace.status}
                  </Badge>
                ),
              },
              {
                term: t('account.slug'),
                description: <code className="font-mono text-xs">{workspace.slug}</code>,
              },
              {
                term: t('account.market'),
                description: t(
                  `account.markets.${workspace.billing_market === 'HU' ? 'HU' : 'INTERNATIONAL'}`,
                ),
              },
              {
                term: t('account.plan'),
                description:
                  workspace.plan_code === null
                    ? '–'
                    : te.has(`planCode.${workspace.plan_code}`)
                      ? te(`planCode.${workspace.plan_code}`)
                      : workspace.plan_code,
              },
              {
                term: t('account.created'),
                description: format.dateTime(new Date(workspace.created_at), {
                  dateStyle: 'long',
                  timeZone: workspace.timezone,
                }),
              },
              {
                term: t('account.id'),
                description: <code className="font-mono text-xs">{workspace.id}</code>,
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
