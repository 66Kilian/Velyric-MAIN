import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  PageHeader,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  type BadgeTone,
} from '@velyric/ui';
import { CalendarDays, Plus, Wrench } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ConnectButton, DisconnectButton } from '@/components/integrations/integration-actions';
import { EmailSenderCard, SmsCard } from '@/components/integrations/messaging-section';
import type { Page } from '@/lib/api-types';
import type { ConnectorType, CustomTool, Integration } from '@/lib/api/integrations';
import type { EmailSender, MessagingSettings } from '@/lib/api/messaging';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('integrations') };
}

const CONNECTORS: readonly ConnectorType[] = ['GOOGLE_CALENDAR', 'MICROSOFT_365'];
const STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  PENDING_AUTHORIZATION: 'sky',
  CONNECTED: 'success',
  DEGRADED: 'warning',
  AUTH_EXPIRED: 'warning',
  REVOKED: 'danger',
  DISCONNECTED: 'neutral',
  ERROR: 'danger',
};

export default async function IntegrationsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'integrations:read');
  const [t, te, format, workspace] = await Promise.all([
    getTranslations('integrations'),
    getTranslations('enums'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
  ]);
  const [integrations, tools, messaging, emailSender] = await Promise.all([
    serverGet<Page<Integration>>('/integrations', {
      workspace: workspaceId,
      query: { limit: 100 },
    }),
    serverGetOrNull<Page<CustomTool>>('/integrations/custom-tools', {
      workspace: workspaceId,
      query: { limit: 100 },
    }),
    serverGet<MessagingSettings>('/messaging-settings', { workspace: workspaceId }),
    serverGetOrNull<EmailSender>('/integrations/smtp', { workspace: workspaceId }),
  ]);
  const callbackStatus = searchValue(search['status']);
  const callbackError = searchValue(search['error']);
  const canManage = permissions.has('integrations:manage');
  const canManageTools = permissions.has('custom_tools:manage');
  const canManageMessaging = permissions.has('notifications:manage');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      {callbackStatus === undefined ? null : (
        <div
          role="status"
          className={`rounded-md border px-4 py-3 text-sm ${callbackStatus === 'connected' ? 'border-success/40 text-success-text' : 'border-danger/40 text-danger-text'} bg-surface`}
        >
          {callbackStatus === 'connected'
            ? t('callback.connected')
            : callbackStatus === 'denied'
              ? t('callback.denied')
              : t('callback.failed', { code: callbackError ?? 'unknown' })}
        </div>
      )}

      <section aria-labelledby="connectors-heading" className="flex flex-col gap-3">
        <h2 id="connectors-heading" className="text-lg font-semibold text-text">
          {t('connectors.title')}
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {CONNECTORS.map((type) => {
            const connections = integrations.data.filter(
              (integration) =>
                integration.integration_type === type && integration.status !== 'DISCONNECTED',
            );
            return (
              <Card key={type}>
                <CardContent className="flex flex-col gap-4 pt-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-pink-tint text-pink-text">
                        <CalendarDays className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <div>
                        <p className="font-semibold text-text">{t(`connectors.${type}.name`)}</p>
                        <p className="text-sm text-text-muted">
                          {t(`connectors.${type}.description`)}
                        </p>
                      </div>
                    </div>
                    {canManage && connections.length === 0 ? (
                      <ConnectButton
                        workspaceId={workspaceId}
                        type={type}
                        integration={null}
                        label={t('connectors.connect')}
                      />
                    ) : null}
                  </div>
                  {connections.map((integration) => (
                    <div
                      key={integration.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium text-text">
                          {integration.display_name ??
                            integration.external_account_ref ??
                            t(`connectors.${type}.name`)}
                        </span>
                        <span className="text-xs text-text-muted">
                          {integration.last_health_check_at === null
                            ? t('connectors.neverChecked')
                            : t('connectors.checked', {
                                time: format.dateTime(new Date(integration.last_health_check_at), {
                                  dateStyle: 'medium',
                                  timeStyle: 'short',
                                  timeZone: workspace.timezone,
                                }),
                              })}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={STATUS_TONES[integration.status] ?? 'neutral'}>
                          {te(`integrationStatus.${integration.status}`)}
                        </Badge>
                        {canManage &&
                        [
                          'AUTH_EXPIRED',
                          'REVOKED',
                          'ERROR',
                          'PENDING_AUTHORIZATION',
                          'DEGRADED',
                        ].includes(integration.status) ? (
                          <ConnectButton
                            workspaceId={workspaceId}
                            type={type}
                            integration={integration}
                            label={t('connectors.reconnect')}
                          />
                        ) : null}
                        {canManage ? (
                          <DisconnectButton workspaceId={workspaceId} integration={integration} />
                        ) : null}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="messaging-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="messaging-heading" className="text-lg font-semibold text-text">
            {t('messaging.title')}
          </h2>
          <p className="text-sm text-text-muted">{t('messaging.description')}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <EmailSenderCard workspaceId={workspaceId} sender={emailSender} canManage={canManage} />
          <SmsCard workspaceId={workspaceId} settings={messaging} canManage={canManageMessaging} />
        </div>
      </section>

      <section aria-labelledby="tools-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="tools-heading" className="text-lg font-semibold text-text">
              {t('tools.title')}
            </h2>
            <p className="text-sm text-text-muted">{t('tools.description')}</p>
          </div>
          {canManageTools ? (
            <Link
              href={`/app/${workspaceId}/integrations/custom-tools/new`}
              className="vly-gradient-cta inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-semibold shadow-cta"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('tools.create')}
            </Link>
          ) : null}
        </div>
        <Card className="overflow-hidden">
          {tools === null || tools.data.length === 0 ? (
            <EmptyState
              icon={<Wrench className="h-5 w-5" aria-hidden="true" />}
              title={t('tools.empty')}
              description={t('tools.emptyDescription')}
              className="m-4 border-none"
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <Tr>
                    <Th>{t('tools.columns.name')}</Th>
                    <Th>{t('tools.columns.endpoint')}</Th>
                    <Th>{t('tools.columns.effect')}</Th>
                    <Th>{t('tools.columns.confirmation')}</Th>
                    <Th>{t('tools.columns.status')}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {tools.data.map((tool) => (
                    <Tr key={tool.id}>
                      <Td>
                        <Link
                          href={`/app/${workspaceId}/integrations/custom-tools/${tool.id}`}
                          className="font-mono text-sm font-medium text-text hover:text-pink-text hover:underline"
                        >
                          {tool.name}
                        </Link>
                      </Td>
                      <Td className="max-w-72 truncate font-mono text-xs text-text-muted">
                        {tool.http_method} {tool.base_url}
                        {tool.path_template}
                      </Td>
                      <Td>{te(`toolSideEffectClass.${tool.side_effect_class}`)}</Td>
                      <Td>{te(`toolConfirmationPolicy.${tool.confirmation_policy}`)}</Td>
                      <Td>
                        <Badge
                          tone={
                            tool.status === 'ACTIVE'
                              ? 'success'
                              : tool.status === 'KILLED'
                                ? 'danger'
                                : 'neutral'
                          }
                        >
                          {t(`tools.status.${tool.status}`)}
                        </Badge>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
