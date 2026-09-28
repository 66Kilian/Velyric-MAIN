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
import { ArrowLeft, ListChecks } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/calls/call-filters';
import { RunStatusBadge } from '@/components/simulation/run-badge';
import {
  ScenarioDialog,
  StartRunDialog,
  SuiteDialog,
} from '@/components/simulation/simulation-forms';
import type { Page } from '@/lib/api-types';
import type { Agent, AgentVersionSummary } from '@/lib/api/agents';
import { RUN_ACTIVE, type SimulationRun, type SimulationSuite } from '@/lib/api/simulation';
import { percent } from '@/lib/format';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ workspace: string; suiteId: string }>;
}): Promise<Metadata> {
  const { workspace, suiteId } = await params;
  const suite = await serverGetOrNull<SimulationSuite>(`/simulation-suites/${suiteId}`, {
    workspace,
  });
  const t = await getTranslations('navigation.app');
  return { title: suite?.name ?? t('simulation') };
}

export default async function SuitePage({
  params,
}: {
  readonly params: Promise<{ workspace: string; suiteId: string }>;
}) {
  const { workspace: workspaceId, suiteId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'simulations:read');
  const [t, te, format, locale, workspace, suite] = await Promise.all([
    getTranslations('simulation'),
    getTranslations('enums'),
    getFormatter(),
    getLocale(),
    getWorkspaceDetail(workspaceId),
    serverGetOrNull<SimulationSuite>(`/simulation-suites/${suiteId}`, { workspace: workspaceId }),
  ]);
  if (suite === null) {
    notFound();
  }
  const canRun = permissions.has('simulations:run');
  const [runs, agent, versions] = await Promise.all([
    serverGet<Page<SimulationRun>>('/simulation-runs', {
      workspace: workspaceId,
      query: { suite_id: suite.id, limit: 30 },
    }),
    permissions.has('agents:read')
      ? serverGetOrNull<Agent>(`/agents/${suite.agent_id}`, { workspace: workspaceId })
      : Promise.resolve(null),
    permissions.has('agents:read')
      ? serverGetOrNull<Page<AgentVersionSummary>>(`/agents/${suite.agent_id}/versions`, {
          workspace: workspaceId,
          query: { limit: 20 },
        })
      : Promise.resolve(null),
  ]);
  const scenarios = suite.scenarios ?? [];
  const activeCount = scenarios.filter((scenario) => scenario.active).length;
  const versionOptions = (versions?.data ?? []).map((version) => ({
    id: version.id,
    label: `v${String(version.version_number)} · ${te.has(`agentVersionStatus.${version.status}`) ? te(`agentVersionStatus.${version.status}`) : version.status}`,
  }));
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
      <Link
        href={`/app/${workspaceId}/simulation`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('back')}
      </Link>
      <PageHeader
        eyebrow={agent?.name}
        title={suite.name}
        description={
          suite.description ??
          t('suiteDescription', { ratio: percent(suite.min_pass_ratio, locale) })
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {suite.is_release_gate ? <Badge tone="violet">{t('releaseGate')}</Badge> : null}
            {canRun ? <SuiteDialog workspaceId={workspaceId} agents={[]} suite={suite} /> : null}
            {canRun ? (
              <StartRunDialog
                workspaceId={workspaceId}
                suiteId={suite.id}
                versions={versionOptions}
                disabled={activeCount === 0}
              />
            ) : null}
          </div>
        }
      />
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('scenarios', { count: activeCount })}</CardTitle>
          {canRun ? <ScenarioDialog workspaceId={workspaceId} suiteId={suite.id} /> : null}
        </CardHeader>
        {scenarios.length === 0 ? (
          <EmptyState
            icon={<ListChecks className="h-5 w-5" aria-hidden="true" />}
            title={t('noScenarios')}
            description={t('noScenariosDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.scenario')}</Th>
                  <Th>{t('columns.class')}</Th>
                  <Th>{t('columns.language')}</Th>
                  <Th>{t('columns.goal')}</Th>
                  <Th>{t('columns.assertions')}</Th>
                  <Th>
                    <span className="sr-only">{t('columns.actions')}</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {scenarios.map((scenario) => (
                  <Tr key={scenario.id} className={scenario.active ? undefined : 'opacity-60'}>
                    <Td className="font-mono text-xs">{scenario.scenario_key}</Td>
                    <Td>{t(`scenario.classes.${scenario.scenario_class}`)}</Td>
                    <Td className="uppercase">{scenario.language}</Td>
                    <Td className="max-w-80 truncate">{scenario.definition.caller_goal}</Td>
                    <Td className="tabular-nums">{scenario.deterministic_assertions.length}</Td>
                    <Td className="text-right">
                      {canRun ? (
                        <ScenarioDialog
                          workspaceId={workspaceId}
                          suiteId={suite.id}
                          scenario={scenario}
                        />
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>{t('runs')}</CardTitle>
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
                  <Th>{t('columns.version')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.results')}</Th>
                  <Th>{t('columns.passRatio')}</Th>
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
                    <Td className="tabular-nums">
                      {versionOptions.find((option) => option.id === run.agent_version_id)?.label ??
                        '–'}
                    </Td>
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
                    <Td className="tabular-nums">
                      {percent(run.scores?.pass_ratio ?? null, locale)}
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
