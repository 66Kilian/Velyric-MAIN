import { Badge, Card, EmptyState } from '@velyric/ui';
import { Webhook } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { CreateWebhookDialog, WebhookControls } from '@/components/settings/webhook-actions';
import { DELIVERY_TONES, type OutboundWebhookList } from '@/lib/api/settings';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.tabs');
  return { title: t('webhooks') };
}

export default async function WebhookSettingsPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'settings:read');
  const [t, format, workspace, webhooks] = await Promise.all([
    getTranslations('settings.webhooks'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
    serverGet<OutboundWebhookList>('/outbound-webhooks', { workspace: workspaceId }),
  ]);
  const canManage = permissions.has('webhooks:manage');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text">{t('title')}</h2>
          <p className="text-sm text-text-muted">{t('description')}</p>
        </div>
        {canManage ? (
          <CreateWebhookDialog
            workspaceId={workspaceId}
            eventTypes={webhooks.event_types}
            disabled={webhooks.data.length >= webhooks.max_endpoints}
          />
        ) : null}
      </div>
      {webhooks.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Webhook className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            description={t('emptyDescription')}
            className="m-4 border-none"
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {webhooks.data.map((webhook) => (
            <li key={webhook.id}>
              <Card className="flex flex-col gap-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <Link
                      href={`/app/${workspaceId}/settings/webhooks/${webhook.id}`}
                      className="truncate font-mono text-sm font-medium text-text hover:text-pink-text hover:underline"
                    >
                      {webhook.url}
                    </Link>
                    <span className="text-xs text-text-muted">
                      {webhook.last_delivery_at === null || webhook.last_delivery_at === undefined
                        ? t('neverDelivered')
                        : t('lastDelivery', {
                            date: format.dateTime(new Date(webhook.last_delivery_at), {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                              timeZone: workspace.timezone,
                            }),
                          })}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {webhook.last_delivery_status === null ||
                    webhook.last_delivery_status === undefined ? null : (
                      <Badge tone={DELIVERY_TONES[webhook.last_delivery_status] ?? 'neutral'}>
                        {t(`statuses.${webhook.last_delivery_status}`)}
                      </Badge>
                    )}
                    {(webhook.failing_deliveries ?? 0) > 0 ? (
                      <Badge tone="danger">
                        {t('failing', { count: webhook.failing_deliveries ?? 0 })}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {webhook.event_types.map((eventType) => (
                    <code
                      key={eventType}
                      className="rounded-md bg-surface-muted px-2 py-0.5 font-mono text-xs text-text-muted"
                    >
                      {eventType}
                    </code>
                  ))}
                </div>
                {canManage ? (
                  <WebhookControls
                    workspaceId={workspaceId}
                    webhook={webhook}
                    eventTypes={webhooks.event_types}
                  />
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-text">{t('verifyTitle')}</h3>
        <p className="mt-1 text-sm text-text-muted">{t('verifyBody')}</p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-muted p-3 font-mono text-xs text-text">
          {'velyric-signature: t=1757923200,v1=<hex HMAC-SHA256 of "t.body">'}
        </pre>
      </Card>
    </div>
  );
}
