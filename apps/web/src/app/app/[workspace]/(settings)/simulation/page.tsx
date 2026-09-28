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
} from '@velyric/ui';
import { FlaskConical } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AutoRefresh } from '@/components/calls/call-filters';
import { RunStatusBadge } from '@/components/simulation/run-badge';
import { SuiteDialog } from '@/components/simulation/simulation-forms';
import type { Page } from '@/lib/api-types';
import type { Agent } from '@/lib/api/agents';
import { RUN_ACTIVE, type SimulationRun, type SimulationSuite } from '@/lib/api/simulation';
import { percent } from '@/lib/format';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('simulation') };
}

export default async function SimulationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'simulations:read');
  const [t, format, locale, workspace] = await Promise.all([
    getTranslations('simulation'),
    getFormatter(),
    getLocale(),
    getWorkspaceDetail(workspaceId),
  ]);
  const agentFilter = searchValue(search['agent_id']);
  const [suites, runs, agents] = await Promise.all([
    serverGet<Page<SimulationSuite>>('/simulation-suites', {
      workspace: workspaceId,
      query: { limit: 100, agent_id: agentFilter },
    }),
    serverGet<Page<SimulationRun>>('/simulation-runs', {
      workspace: workspaceId,
      query: { limit: 20 },
    }),
    permissions.has('agents:read')
      ? serverGetOrNull<Page<Agent>>('/agents', { workspace: workspaceId, query: { limit: 200 } })
      : Promise.resolve(null),
  ]);
  const agentNames = new Map((agents?.data ?? []).map((agent) => [agent.id, agent.name]));
  const suiteNames = new Map(suites.data.map((suite) => [suite.id, suite.name]));
  const canRun = permissions.has('simulations:run');
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
      {runs.data.some((run) => RUN_ACTIVE.has(run.status)) ? (
        <AutoRefresh intervalMs={5000} />
      ) : null}
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canRun ? (
            <SuiteDialog
              workspaceId={workspaceId}
              agents={(agents?.data ?? [])
                .filter((agent) => agent.status !== 'ARCHIVED')
                .map((agent) => ({ id: agent.id, name: agent.name }))}
            />
          ) : undefined
        }
      />
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>{t('suites')}</CardTitle>
        </CardHeader>
        {suites.data.length === 0 ? (
          <EmptyState
            icon={<FlaskConical className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            description={t('emptyDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.suite')}</Th>
                  <Th>{t('columns.agent')}</Th>
                  <Th>{t('columns.gate')}</Th>
                  <Th>{t('columns.passRatio')}</Th>
                  <Th>{t('columns.updated')}</Th>
                </Tr>
              </THead>
              <TBody>
                {suites.data.map((suite) => (
                  <Tr key={suite.id}>
                    <Td>
                      <Link
                        href={`/app/${workspaceId}/simulation/${suite.id}`}
                        className="font-medium text-text hover:text-pink-text hover:underline"
                      >
                        {suite.name}
                      </Link>
                    </Td>
                    <Td>{agentNames.get(suite.agent_id) ?? '–'}</Td>
                    <Td>
                      {suite.is_release_gate ? (
                        <Badge tone="violet">{t('releaseGate')}</Badge>
                      ) : (
                        '–'
                      )}
                    </Td>
                    <Td className="tabular-nums">{percent(suite.min_pass_ratio, locale)}</Td>
                    <Td className="whitespace-nowrap">{dateTime(suite.updated_at)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>{t('recentRuns')}</CardTitle>
        </CardHeader>
        {runs.data.length === 0 ? (
          <CardContent>
            <p className="text-sm text-text-muted">{t('noRuns')}</p>
          </CardContent>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.started')}</Th>
                  <Th>{t('columns.suite')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.results')}</Th>
                </Tr>
              </THead>
              <TBody>
                {runs.data.map((run) => (
                  <Tr key={run.id}>
                    <Td className="whitespace-nowrap">
                      <Link
                        href={`/app/${workspaceId}/simulation/runs/${run.id}`}
                        className="font-medium text-text hover:text-pink-text hover:underline"
                      >
                        {dateTime(run.created_at)}
                      </Link>
                    </Td>
                    <Td>{suiteNames.get(run.suite_id) ?? '–'}</Td>
                    <Td>
                      <RunStatusBadge status={run.status} />
                    </Td>
                    <Td className="tabular-nums">
                      {t('counts', {
                        passed: run.passed_count,
                        failed: run.failed_count,
                        errored: run.errored_count,
                      })}
                    </Td>
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
