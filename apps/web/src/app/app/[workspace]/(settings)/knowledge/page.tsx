import {
  Badge,
  Card,
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
import { KNOWLEDGE_STATUS_TONES } from '@/components/knowledge/tones';
import { BookOpen } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AutoRefresh } from '@/components/calls/call-filters';
import { CursorPager } from '@/components/common/navigation';
import { CreateKnowledgeSourceDialog } from '@/components/knowledge/knowledge-actions';
import type { Page } from '@/lib/api-types';
import type { KnowledgeSource } from '@/lib/api/knowledge';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('knowledge') };
}

const FRESHNESS_TONES: Readonly<Record<string, BadgeTone>> = {
  FRESH: 'success',
  STALE: 'warning',
  EXPIRED: 'danger',
  UNKNOWN: 'neutral',
};
const IN_FLIGHT = new Set(['QUEUED', 'SCANNING', 'PARSING', 'CHUNKING', 'EMBEDDING']);
const STATUS_FILTERS = ['ACTIVE', 'FAILED', 'QUARANTINED', 'PENDING_UPLOAD', 'ARCHIVED'] as const;

export default async function KnowledgePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'knowledge:read');
  const [t, te, format, workspace] = await Promise.all([
    getTranslations('knowledge'),
    getTranslations('enums'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
  ]);
  const status = searchValue(search['status']);
  const [sources, locations] = await Promise.all([
    serverGet<Page<KnowledgeSource>>('/knowledge-sources', {
      workspace: workspaceId,
      query: { limit: 50, cursor: searchValue(search['cursor']), status },
    }),
    permissions.has('locations:read')
      ? serverGetOrNull<{ data: { id: string; name: string }[] }>('/locations', {
          workspace: workspaceId,
        })
      : Promise.resolve(null),
  ]);
  const refreshing = sources.data.some((source) => IN_FLIGHT.has(source.status));

  return (
    <div className="flex flex-col gap-6">
      {refreshing ? <AutoRefresh intervalMs={5000} /> : null}
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          permissions.has('knowledge:write') ? (
            <CreateKnowledgeSourceDialog
              workspaceId={workspaceId}
              locations={locations?.data ?? []}
            />
          ) : undefined
        }
      />
      <nav aria-label={t('filterLabel')} className="flex flex-wrap gap-2">
        <Link
          href={`/app/${workspaceId}/knowledge`}
          aria-current={status === undefined ? 'page' : undefined}
          className={`rounded-full px-3 py-1 text-sm ${status === undefined ? 'bg-pink-tint-strong text-pink-text' : 'bg-surface text-text-muted hover:text-text'}`}
        >
          {t('allSources')}
        </Link>
        {STATUS_FILTERS.map((value) => (
          <Link
            key={value}
            href={`/app/${workspaceId}/knowledge?status=${value}`}
            aria-current={status === value ? 'page' : undefined}
            className={`rounded-full px-3 py-1 text-sm ${status === value ? 'bg-pink-tint-strong text-pink-text' : 'bg-surface text-text-muted hover:text-text'}`}
          >
            {te(`knowledgeSourceStatus.${value}`)}
          </Link>
        ))}
      </nav>
      <Card className="overflow-hidden">
        {sources.data.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            description={t('emptyDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.title')}</Th>
                  <Th>{t('columns.type')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.freshness')}</Th>
                  <Th>{t('columns.language')}</Th>
                  <Th>{t('columns.synced')}</Th>
                </Tr>
              </THead>
              <TBody>
                {sources.data.map((source) => (
                  <Tr key={source.id}>
                    <Td className="max-w-80">
                      <Link
                        href={`/app/${workspaceId}/knowledge/${source.id}`}
                        className="block truncate font-medium text-text hover:text-pink-text hover:underline"
                      >
                        {source.title}
                      </Link>
                      {source.uri === null ? null : (
                        <span className="block truncate text-xs text-text-muted">{source.uri}</span>
                      )}
                    </Td>
                    <Td>{te(`knowledgeSourceType.${source.source_type}`)}</Td>
                    <Td>
                      <Badge tone={KNOWLEDGE_STATUS_TONES[source.status] ?? 'neutral'}>
                        {te(`knowledgeSourceStatus.${source.status}`)}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge tone={FRESHNESS_TONES[source.freshness] ?? 'neutral'}>
                        {te(`knowledgeFreshness.${source.freshness}`)}
                      </Badge>
                    </Td>
                    <Td className="uppercase">{source.language ?? '–'}</Td>
                    <Td className="whitespace-nowrap">
                      {source.last_synced_at === null
                        ? '–'
                        : format.dateTime(new Date(source.last_synced_at), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                            timeZone: workspace.timezone,
                          })}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      <CursorPager nextCursor={sources.page.next_cursor} />
    </div>
  );
}
