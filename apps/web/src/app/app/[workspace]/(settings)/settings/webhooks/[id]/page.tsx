import {
  Badge,
  Card,
  EmptyState,
  NativeSelect,
  Button,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@velyric/ui';
import { ArrowLeft, Inbox } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CursorPager } from '@/components/common/navigation';
import { RetryDeliveryButton } from '@/components/settings/webhook-actions';
import type { Page } from '@/lib/api-types';
import { DELIVERY_TONES, type OutboundWebhookList, type WebhookDelivery } from '@/lib/api/settings';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

const STATUSES = ['PENDING', 'DELIVERED', 'RETRYING', 'FAILED', 'DEAD_LETTER'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.webhooks');
  return { title: t('deliveries') };
}

export default async function WebhookDeliveriesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId, id }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'settings:read');
  const requested = searchValue(search['status']);
  const status = STATUSES.find((value) => value === requested);
  const [t, tc, format, workspace, webhooks] = await Promise.all([
    getTranslations('settings.webhooks'),
    getTranslations('common.actions'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
    serverGet<OutboundWebhookList>('/outbound-webhooks', { workspace: workspaceId }),
  ]);
  const webhook = webhooks.data.find((entry) => entry.id === id);
  if (webhook === undefined) {
    notFound();
  }
  const deliveries = await serverGet<Page<WebhookDelivery>>(`/outbound-webhooks/${id}/deliveries`, {
    workspace: workspaceId,
    query: { status, cursor: searchValue(search['cursor']), limit: 50 },
  });
  const canManage = permissions.has('webhooks:manage');
  const when = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), {
          dateStyle: 'medium',
          timeStyle: 'medium',
          timeZone: workspace.timezone,
        });

  return (
    <div className="flex flex-col gap-4">
      <Link
        href={`/app/${workspaceId}/settings/webhooks`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('back')}
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text">{t('deliveries')}</h2>
          <p className="truncate font-mono text-sm text-text-muted">{webhook.url}</p>
        </div>
        <form method="get" className="flex gap-2">
          <NativeSelect name="status" defaultValue={status ?? ''} aria-label={t('statusFilter')}>
            <option value="">{t('allStatuses')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`statuses.${value}`)}
              </option>
            ))}
          </NativeSelect>
          <Button type="submit" variant="secondary">
            {tc('filter')}
          </Button>
        </form>
      </div>
      <Card className="overflow-hidden">
        {deliveries.data.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-5 w-5" aria-hidden="true" />}
            title={t('noDeliveries')}
            description={t('noDeliveriesDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.created')}</Th>
                  <Th>{t('columns.event')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.attempts')}</Th>
                  <Th>{t('columns.response')}</Th>
                  <Th>{t('columns.next')}</Th>
                  {canManage ? <Th /> : null}
                </Tr>
              </THead>
              <TBody>
                {deliveries.data.map((delivery) => (
                  <Tr key={delivery.id}>
                    <Td className="whitespace-nowrap">{when(delivery.created_at)}</Td>
                    <Td>
                      <code className="font-mono text-xs">{delivery.event_type}</code>
                    </Td>
                    <Td>
                      <Badge tone={DELIVERY_TONES[delivery.status] ?? 'neutral'}>
                        {t(`statuses.${delivery.status}`)}
                      </Badge>
                    </Td>
                    <Td className="tabular-nums">{delivery.attempt}</Td>
                    <Td className="whitespace-nowrap tabular-nums text-text-muted">
                      {delivery.http_status === null
                        ? (delivery.last_error_code ?? '–')
                        : `HTTP ${String(delivery.http_status)}`}
                      {delivery.response_ms === null
                        ? null
                        : ` · ${String(delivery.response_ms)} ms`}
                    </Td>
                    <Td className="whitespace-nowrap">{when(delivery.next_attempt_at)}</Td>
                    {canManage ? (
                      <Td className="text-right">
                        {delivery.status === 'FAILED' || delivery.status === 'DEAD_LETTER' ? (
                          <RetryDeliveryButton
                            workspaceId={workspaceId}
                            webhookId={webhook.id}
                            delivery={delivery}
                          />
                        ) : null}
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      <CursorPager nextCursor={deliveries.page.next_cursor} />
    </div>
  );
}
