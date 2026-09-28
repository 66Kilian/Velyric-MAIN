import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DescriptionList,
  PageHeader,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@velyric/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/calls/call-filters';
import { FaqEntriesPanel, KnowledgeSourceActions } from '@/components/knowledge/knowledge-actions';
import type { KnowledgeSourceDetail } from '@/lib/api/knowledge';
import { serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';
import { KNOWLEDGE_STATUS_TONES } from '@/components/knowledge/tones';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
}): Promise<Metadata> {
  const { workspace, id } = await params;
  const source = await serverGetOrNull<KnowledgeSourceDetail>(`/knowledge-sources/${id}`, {
    workspace,
  });
  const t = await getTranslations('navigation.app');
  return { title: source?.title ?? t('knowledge') };
}

const IN_FLIGHT = new Set([
  'PENDING_UPLOAD',
  'QUEUED',
  'SCANNING',
  'PARSING',
  'CHUNKING',
  'EMBEDDING',
]);

function formatBytes(
  bytes: number,
  formatNumber: (value: number, fractionDigits: number) => string,
): string {
  if (bytes >= 1024 * 1024) {
    return `${formatNumber(bytes / (1024 * 1024), 1)} MB`;
  }
  return `${formatNumber(Math.max(1, bytes / 1024), 0)} KB`;
}

export default async function KnowledgeSourcePage({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: workspaceId, id } = await params;
  const { permissions } = await requirePermission(workspaceId, 'knowledge:read');
  const [t, te, format, workspace, source] = await Promise.all([
    getTranslations('knowledge'),
    getTranslations('enums'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
    serverGetOrNull<KnowledgeSourceDetail>(`/knowledge-sources/${id}`, { workspace: workspaceId }),
  ]);
  if (source === null) {
    notFound();
  }
  const faq = source.source_type === 'FAQ' || source.source_type === 'MANUAL_QA';
  const entries = faq
    ? await serverGetOrNull<{ entries: { question: string; answer: string }[] }>(
        `/knowledge-sources/${id}/entries`,
        { workspace: workspaceId },
      )
    : null;
  const dateTime = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: workspace.timezone,
        });
  const canWrite = permissions.has('knowledge:write');

  return (
    <div className="flex flex-col gap-6">
      {IN_FLIGHT.has(source.status) ? <AutoRefresh intervalMs={4000} /> : null}
      <Link
        href={`/app/${workspaceId}/knowledge`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('detail.back')}
      </Link>
      <PageHeader
        eyebrow={te(`knowledgeSourceType.${source.source_type}`)}
        title={source.title}
        description={source.uri ?? undefined}
        actions={
          <div className="flex flex-wrap items-start gap-3">
            <Badge tone={KNOWLEDGE_STATUS_TONES[source.status] ?? 'neutral'}>
              {te(`knowledgeSourceStatus.${source.status}`)}
            </Badge>
            <KnowledgeSourceActions workspaceId={workspaceId} source={source} canWrite={canWrite} />
          </div>
        }
      />
      {source.last_error_code === null ? null : (
        <div
          role="alert"
          className="rounded-md border border-danger/40 bg-surface px-4 py-3 text-sm text-danger-text"
        >
          {t.has(`errors.${source.last_error_code}`)
            ? t(`errors.${source.last_error_code}`)
            : t('errors.generic', { code: source.last_error_code })}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.facts')}</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                {
                  term: t('columns.freshness'),
                  description: te(`knowledgeFreshness.${source.freshness}`),
                },
                { term: t('columns.language'), description: source.language?.toUpperCase() ?? '–' },
                {
                  term: t('detail.size'),
                  description:
                    source.size_bytes === null
                      ? '–'
                      : formatBytes(source.size_bytes, (value, fractionDigits) =>
                          format.number(value, { maximumFractionDigits: fractionDigits }),
                        ),
                },
                {
                  term: t('detail.refresh'),
                  description:
                    source.freshness_ttl_hours === null
                      ? '–'
                      : t('detail.everyHours', { hours: source.freshness_ttl_hours }),
                },
                { term: t('columns.synced'), description: dateTime(source.last_synced_at) },
                { term: t('detail.validTo'), description: dateTime(source.valid_to) },
                {
                  term: t('detail.acl'),
                  description:
                    source.acl.length === 0 ? t('detail.everyone') : source.acl.join(', '),
                },
                { term: t('detail.created'), description: dateTime(source.created_at) },
              ]}
            />
          </CardContent>
        </Card>
        <Card className="overflow-hidden xl:col-span-2">
          <CardHeader>
            <CardTitle>{t('detail.versions')}</CardTitle>
          </CardHeader>
          {source.versions.length === 0 ? (
            <CardContent>
              <p className="text-sm text-text-muted">{t('detail.noVersions')}</p>
            </CardContent>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <Tr>
                    <Th>{t('detail.version')}</Th>
                    <Th>{t('columns.status')}</Th>
                    <Th>{t('detail.chunks')}</Th>
                    <Th>{t('detail.scan')}</Th>
                    <Th>{t('detail.pii')}</Th>
                    <Th>{t('detail.activated')}</Th>
                    <Th>
                      <span className="sr-only">{t('detail.view')}</span>
                    </Th>
                  </Tr>
                </THead>
                <TBody>
                  {source.versions.map((version) => (
                    <Tr key={version.id}>
                      <Td className="font-semibold tabular-nums">v{version.version_number}</Td>
                      <Td>
                        <Badge tone={KNOWLEDGE_STATUS_TONES[version.status] ?? 'neutral'}>
                          {te(`knowledgeSourceStatus.${version.status}`)}
                        </Badge>
                        {version.error_code === null ? null : (
                          <span className="ml-2 font-mono text-xs text-danger-text">
                            {version.error_code}
                          </span>
                        )}
                      </Td>
                      <Td className="tabular-nums">{format.number(version.chunk_count)}</Td>
                      <Td>
                        {version.malware_scan_result === null ? (
                          '–'
                        ) : (
                          <Badge
                            tone={version.malware_scan_result === 'CLEAN' ? 'success' : 'danger'}
                          >
                            {t(`scan.${version.malware_scan_result}`)}
                          </Badge>
                        )}
                      </Td>
                      <Td>
                        {version.pii_findings.length === 0 ? (
                          '–'
                        ) : (
                          <Badge tone="warning">{version.pii_findings.join(', ')}</Badge>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap">{dateTime(version.activated_at)}</Td>
                      <Td className="text-right">
                        {version.chunk_count === 0 ? null : (
                          <Button asChild variant="ghost" size="sm">
                            <Link
                              href={`/app/${workspaceId}/knowledge/${source.id}/versions/${version.id}`}
                            >
                              {t('detail.view')}
                            </Link>
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      </div>
      {faq ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('faq.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {entries === null ? (
              <p className="text-sm text-text-muted">{t('faq.unavailable')}</p>
            ) : (
              <FaqEntriesPanel
                workspaceId={workspaceId}
                sourceId={source.id}
                version={source.version}
                initial={entries.entries}
                canWrite={canWrite && source.status !== 'ARCHIVED'}
              />
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
