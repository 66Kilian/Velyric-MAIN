import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
import { ArrowLeft, GitCompare } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PublishVersionButton, RollbackVersionButton } from '@/components/agents/agent-actions';
import { CursorPager } from '@/components/common/navigation';
import type { Page } from '@/lib/api-types';
import type { AgentDetail, AgentVersionDetail, AgentVersionSummary } from '@/lib/api/agents';
import { diffJson, formatJsonValue } from '@/lib/json-diff';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('agents.versions');
  return { title: t('title') };
}

const VERSION_TONES: Readonly<Record<string, BadgeTone>> = {
  DRAFT: 'neutral',
  VALIDATING: 'sky',
  VALIDATION_FAILED: 'danger',
  STAGING: 'sky',
  CANARY: 'peach',
  PRODUCTION: 'success',
  SUPERSEDED: 'neutral',
  ROLLED_BACK: 'warning',
};
const PUBLISHABLE = new Set(['DRAFT', 'STAGING', 'VALIDATION_FAILED']);
const RESTORABLE = new Set(['SUPERSEDED', 'ROLLED_BACK']);

export default async function AgentVersionsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId, id }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'agents:read');
  const [t, te, format, workspace, agent] = await Promise.all([
    getTranslations('agents'),
    getTranslations('enums'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
    serverGetOrNull<AgentDetail>(`/agents/${id}`, { workspace: workspaceId }),
  ]);
  if (agent === null) {
    notFound();
  }
  const versions = await serverGet<Page<AgentVersionSummary>>(`/agents/${id}/versions`, {
    workspace: workspaceId,
    query: { limit: 50, cursor: searchValue(search['cursor']) },
  });
  const base = searchValue(search['base']);
  const target = searchValue(search['target']);
  const [baseVersion, targetVersion] =
    base !== undefined && target !== undefined
      ? await Promise.all([
          serverGetOrNull<AgentVersionDetail>(`/agent-versions/${base}`, {
            workspace: workspaceId,
          }),
          serverGetOrNull<AgentVersionDetail>(`/agent-versions/${target}`, {
            workspace: workspaceId,
          }),
        ])
      : [null, null];
  const diff =
    baseVersion !== null && targetVersion !== null
      ? diffJson(baseVersion.config, targetVersion.config)
      : null;
  const dateTime = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: workspace.timezone,
        });

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/app/${workspaceId}/agents/${id}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {agent.name}
      </Link>
      <PageHeader title={t('versions.title')} description={t('versions.description')} />
      <Card className="overflow-hidden">
        {versions.data.length === 0 ? (
          <EmptyState
            title={t('versions.empty')}
            description={t('versions.emptyDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('versions.version')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('versions.summary')}</Th>
                  <Th>{t('versions.created')}</Th>
                  <Th>{t('versions.published')}</Th>
                  <Th>
                    <span className="sr-only">{t('versions.actions')}</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {versions.data.map((version, index) => {
                  const previous = versions.data[index + 1];
                  return (
                    <Tr key={version.id}>
                      <Td className="font-semibold tabular-nums">v{version.version_number}</Td>
                      <Td>
                        <Badge tone={VERSION_TONES[version.status] ?? 'neutral'}>
                          {te(`agentVersionStatus.${version.status}`)}
                          {version.status === 'CANARY' && version.rollout_percent !== null
                            ? ` · ${String(version.rollout_percent)}%`
                            : ''}
                        </Badge>
                      </Td>
                      <Td className="max-w-72 truncate text-text-muted">
                        {version.change_summary ?? '–'}
                      </Td>
                      <Td className="whitespace-nowrap">{dateTime(version.created_at)}</Td>
                      <Td className="whitespace-nowrap">{dateTime(version.published_at)}</Td>
                      <Td>
                        <div className="flex justify-end gap-2">
                          {previous === undefined ? null : (
                            <Link
                              href={`/app/${workspaceId}/agents/${id}/versions?base=${previous.id}&target=${version.id}#diff`}
                              className="inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-[13px] font-medium text-violet-text hover:bg-pink-tint"
                            >
                              <GitCompare className="h-4 w-4" aria-hidden="true" />
                              {t('versions.compare')}
                            </Link>
                          )}
                          {permissions.has('agent_versions:publish') &&
                          PUBLISHABLE.has(version.status) ? (
                            <PublishVersionButton
                              workspaceId={workspaceId}
                              versionId={version.id}
                              versionNumber={version.version_number}
                            />
                          ) : null}
                          {permissions.has('agent_versions:rollback') &&
                          RESTORABLE.has(version.status) &&
                          version.published_at !== null ? (
                            <RollbackVersionButton
                              workspaceId={workspaceId}
                              versionId={version.id}
                              versionNumber={version.version_number}
                            />
                          ) : null}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      <CursorPager nextCursor={versions.page.next_cursor} />
      {diff !== null && baseVersion !== null && targetVersion !== null ? (
        <Card id="diff">
          <CardHeader>
            <CardTitle>
              {t('versions.diffTitle', {
                base: baseVersion.version_number,
                target: targetVersion.version_number,
              })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {diff.length === 0 ? (
              <p className="text-sm text-text-muted">{t('versions.noChanges')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {diff.map((entry) => (
                  <li
                    key={entry.path}
                    className="grid gap-2 py-3 md:grid-cols-[minmax(12rem,1fr)_2fr_2fr]"
                  >
                    <span className="flex items-center gap-2">
                      <Badge
                        tone={
                          entry.kind === 'added'
                            ? 'success'
                            : entry.kind === 'removed'
                              ? 'danger'
                              : 'sky'
                        }
                      >
                        {t(`versions.diffKinds.${entry.kind}`)}
                      </Badge>
                      <code className="break-all font-mono text-xs text-text">{entry.path}</code>
                    </span>
                    <code className="break-words rounded-sm bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-2 py-1 font-mono text-xs text-text">
                      {formatJsonValue(entry.before)}
                    </code>
                    <code className="break-words rounded-sm bg-[var(--tag-mint-bg)] px-2 py-1 font-mono text-xs text-text">
                      {formatJsonValue(entry.after)}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
