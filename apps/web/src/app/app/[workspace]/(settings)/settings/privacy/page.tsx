import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  NativeSelect,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@velyric/ui';
import { ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CursorPager } from '@/components/common/navigation';
import {
  CreateLegalHoldDialog,
  CreatePrivacyRequestDialog,
  PrivacyRequestActions,
  ReleaseLegalHoldButton,
} from '@/components/settings/privacy-actions';
import type { Page } from '@/lib/api-types';
import { PRIVACY_REQUEST_TONES, type LegalHold, type PrivacyRequest } from '@/lib/api/settings';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

const STATUSES = [
  'RECEIVED',
  'VERIFYING',
  'IN_PROGRESS',
  'ON_LEGAL_HOLD',
  'COMPLETED',
  'REJECTED',
] as const;
const TYPES = ['DELETE', 'EXPORT', 'RECTIFY', 'RESTRICT'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.tabs');
  return { title: t('privacy') };
}

export default async function PrivacySettingsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'privacy_requests:manage');
  const status = STATUSES.find((value) => value === searchValue(search['status']));
  const requestType = TYPES.find((value) => value === searchValue(search['request_type']));
  const [t, tc, format, workspace, requests, holds] = await Promise.all([
    getTranslations('settings.privacy'),
    getTranslations('common.actions'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
    serverGet<Page<PrivacyRequest>>('/privacy-requests', {
      workspace: workspaceId,
      query: {
        status,
        request_type: requestType,
        cursor: searchValue(search['cursor']),
        limit: 50,
      },
    }),
    serverGet<Page<LegalHold>>('/legal-holds', { workspace: workspaceId, query: { limit: 100 } }),
  ]);
  const when = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), { dateStyle: 'medium', timeZone: workspace.timezone });
  const now = Date.now();
  const canRelease = permissions.has('retention:manage');

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{t('title')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </div>
          <CreatePrivacyRequestDialog workspaceId={workspaceId} />
        </CardHeader>
        <form method="get" className="flex flex-wrap gap-3 px-5 pb-4" aria-label={t('filters')}>
          <NativeSelect name="status" defaultValue={status ?? ''} aria-label={t('statusFilter')}>
            <option value="">{t('allStatuses')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`statuses.${value}`)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            name="request_type"
            defaultValue={requestType ?? ''}
            aria-label={t('typeFilter')}
          >
            <option value="">{t('allTypes')}</option>
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`types.${value}`)}
              </option>
            ))}
          </NativeSelect>
          <Button type="submit" variant="secondary">
            {tc('filter')}
          </Button>
        </form>
        {requests.data.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            description={t('emptyDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.person')}</Th>
                  <Th>{t('columns.type')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.received')}</Th>
                  <Th>{t('columns.due')}</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {requests.data.map((request) => {
                  const overdue =
                    request.completed_at === null &&
                    request.status !== 'REJECTED' &&
                    new Date(request.due_at).getTime() < now;
                  return (
                    <Tr key={request.id}>
                      <Td>
                        {request.person_id === null ? (
                          t('erased')
                        ) : (
                          <span className="font-medium text-text">
                            {request.person_display_name ?? t('unnamed')}
                          </span>
                        )}
                      </Td>
                      <Td>{t(`types.${request.request_type}`)}</Td>
                      <Td>
                        <span className="flex flex-col items-start gap-1">
                          <Badge tone={PRIVACY_REQUEST_TONES[request.status] ?? 'neutral'}>
                            {t(`statuses.${request.status}`)}
                          </Badge>
                          {request.rejection_reason === null ? null : (
                            <span className="max-w-64 truncate text-xs text-text-muted">
                              {request.rejection_reason}
                            </span>
                          )}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">
                        <span className="flex flex-col">
                          <span>{when(request.created_at)}</span>
                          <span className="text-xs text-text-muted">
                            {t(`channels.${request.received_via}`)}
                          </span>
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {request.completed_at === null ? (
                          <span className={overdue ? 'font-medium text-danger-text' : undefined}>
                            {when(request.due_at)}
                          </span>
                        ) : (
                          t('completedOn', { date: when(request.completed_at) })
                        )}
                      </Td>
                      <Td>
                        <PrivacyRequestActions workspaceId={workspaceId} request={request} />
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      <CursorPager nextCursor={requests.page.next_cursor} />

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{t('holds.title')}</CardTitle>
            <CardDescription>{t('holds.description')}</CardDescription>
          </div>
          <CreateLegalHoldDialog workspaceId={workspaceId} />
        </CardHeader>
        {holds.data.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-text-muted">{t('holds.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('holds.columns.scope')}</Th>
                  <Th>{t('holds.columns.basis')}</Th>
                  <Th>{t('holds.columns.created')}</Th>
                  <Th>{t('holds.columns.status')}</Th>
                  {canRelease ? <Th /> : null}
                </Tr>
              </THead>
              <TBody>
                {holds.data.map((hold) => (
                  <Tr key={hold.id}>
                    <Td>
                      <span className="flex flex-col">
                        <span className="font-medium">{t(`holds.scopes.${hold.scope_type}`)}</span>
                        {hold.scope_ref === null ? null : (
                          <code className="font-mono text-xs text-text-muted">
                            {hold.scope_ref}
                          </code>
                        )}
                      </span>
                    </Td>
                    <Td>
                      <span className="flex max-w-80 flex-col">
                        <span>{hold.legal_basis}</span>
                        <span className="truncate text-xs text-text-muted">{hold.reason}</span>
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap">{when(hold.created_at)}</Td>
                    <Td>
                      <Badge tone={hold.active ? 'peach' : 'neutral'}>
                        {hold.active
                          ? t('holds.active')
                          : t('holds.releasedOn', { date: when(hold.released_at) })}
                      </Badge>
                    </Td>
                    {canRelease ? (
                      <Td className="text-right">
                        {hold.active &&
                        hold.scope_type !== 'DISPUTE' &&
                        hold.scope_type !== 'BILLING' ? (
                          <ReleaseLegalHoldButton workspaceId={workspaceId} hold={hold} />
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
    </div>
  );
}
