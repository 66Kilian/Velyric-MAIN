import {
  Badge,
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
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/calls/call-filters';
import { RunStatusBadge } from '@/components/simulation/run-badge';
import { CancelRunButton } from '@/components/simulation/simulation-forms';
import { RUN_ACTIVE, type SimulationRun, type SimulationSuite } from '@/lib/api/simulation';
import { clock, percent } from '@/lib/format';
import { serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('simulation');
  return { title: t('runTitle') };
}

export default async function RunPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; runId: string }>;
}) {
  const { workspace: workspaceId, runId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'simulations:read');
  const [t, te, format, locale, workspace, run] = await Promise.all([
    getTranslations('simulation'),
    getTranslations('enums'),
    getFormatter(),
    getLocale(),
    getWorkspaceDetail(workspaceId),
    serverGetOrNull<SimulationRun>(`/simulation-runs/${runId}`, { workspace: workspaceId }),
  ]);
  if (run === null) {
    notFound();
  }
  const suite = await serverGetOrNull<SimulationSuite>(`/simulation-suites/${run.suite_id}`, {
    workspace: workspaceId,
  });
  const scenarioKeys = new Map(
    (suite?.scenarios ?? []).map((scenario) => [scenario.id, scenario.scenario_key]),
  );
  const results = run.scores?.results ?? [];
  const previous = new Map(
    (run.previous_run?.scores?.results ?? []).map((result) => [result.scenario_id, result]),
  );
  const active = RUN_ACTIVE.has(run.status);
  const dateTime = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), {
          dateStyle: 'medium',
          timeStyle: 'medium',
          timeZone: workspace.timezone,
        });

  return (
    <div className="flex flex-col gap-6">
      {active ? <AutoRefresh intervalMs={4000} /> : null}
      <Link
        href={
          suite === null
            ? `/app/${workspaceId}/simulation`
            : `/app/${workspaceId}/simulation/${suite.id}`
        }
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {suite?.name ?? t('back')}
      </Link>
      <PageHeader
        title={t('runTitle')}
        description={dateTime(run.created_at)}
        actions={
          <div className="flex items-center gap-2">
            <RunStatusBadge status={run.status} />
            {active && permissions.has('simulations:run') ? (
              <CancelRunButton workspaceId={workspaceId} runId={run.id} />
            ) : null}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t('summary')}</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                {
                  term: t('columns.results'),
                  description: t('counts', {
                    passed: run.passed_count,
                    failed: run.failed_count,
                    errored: run.errored_count,
                  }),
                },
                {
                  term: t('columns.passRatio'),
                  description: `${percent(run.scores?.pass_ratio ?? null, locale)} / ${percent(run.scores?.min_pass_ratio ?? suite?.min_pass_ratio ?? null, locale)}`,
                },
                {
                  term: t('gate'),
                  description:
                    run.gate_passed === null ? (
                      '–'
                    ) : run.gate_passed ? (
                      <Badge tone="success">{t('gatePassed')}</Badge>
                    ) : (
                      <Badge tone="danger">{t('gateFailed')}</Badge>
                    ),
                },
                { term: t('started'), description: dateTime(run.started_at) },
                { term: t('finished'), description: dateTime(run.finished_at) },
                {
                  term: t('models'),
                  description:
                    Object.entries(run.model_versions)
                      .map(([role, model]) => `${role}: ${model}`)
                      .join(', ') || '–',
                },
                {
                  term: t('rubric'),
                  description: <code className="font-mono text-xs">{run.rubric_version}</code>,
                },
                ...(run.scores?.error_code === undefined
                  ? []
                  : [
                      {
                        term: t('error'),
                        description: (
                          <code className="font-mono text-xs text-danger-text">
                            {run.scores.error_code}
                          </code>
                        ),
                      },
                    ]),
              ]}
            />
          </CardContent>
        </Card>
        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('results')}</CardTitle>
          </CardHeader>
          {results.length === 0 ? (
            <CardContent>
              <p className="text-sm text-text-muted">{active ? t('inProgress') : t('noResults')}</p>
            </CardContent>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <Tr>
                    <Th>{t('columns.scenario')}</Th>
                    <Th>{t('columns.verdict')}</Th>
                    <Th>{t('columns.score')}</Th>
                    <Th>{t('columns.change')}</Th>
                    <Th>{t('columns.details')}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {results.map((result) => {
                    const before = previous.get(result.scenario_id);
                    const regressed = before?.verdict === 'PASSED' && result.verdict !== 'PASSED';
                    const fixed =
                      before !== undefined &&
                      before.verdict !== 'PASSED' &&
                      result.verdict === 'PASSED';
                    return (
                      <Tr key={result.scenario_id}>
                        <Td className="font-mono text-xs">
                          {scenarioKeys.get(result.scenario_id) ?? result.scenario_id.slice(0, 8)}
                        </Td>
                        <Td>
                          <Badge
                            tone={
                              result.verdict === 'PASSED'
                                ? 'success'
                                : result.verdict === 'FAILED'
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {t(`verdicts.${result.verdict}`)}
                          </Badge>
                        </Td>
                        <Td className="tabular-nums">
                          {format.number(result.score, { maximumFractionDigits: 2 })}
                        </Td>
                        <Td>
                          {regressed ? (
                            <Badge tone="danger">{t('regressed')}</Badge>
                          ) : fixed ? (
                            <Badge tone="success">{t('fixed')}</Badge>
                          ) : before === undefined ? (
                            '–'
                          ) : (
                            t('unchanged')
                          )}
                        </Td>
                        <Td className="max-w-md text-xs text-text-muted">
                          <span className="block">
                            {t('resultMeta', {
                              turns: result.turns,
                              duration: clock(result.duration_ms / 1000),
                            })}
                            {result.outcome === undefined
                              ? ''
                              : ` · ${te.has(`callOutcome.${result.outcome}`) ? te(`callOutcome.${result.outcome}`) : result.outcome}`}
                          </span>
                          {result.tools_called.length === 0 ? null : (
                            <span className="block font-mono">
                              {result.tools_called.join(', ')}
                            </span>
                          )}
                          {result.failed_assertions.map((failure) => (
                            <span key={failure} className="block text-danger-text">
                              {failure}
                            </span>
                          ))}
                          {result.error_code === undefined ? null : (
                            <span className="block font-mono text-warning-text">
                              {result.error_code}
                            </span>
                          )}
                          {result.judge_notes === undefined ? null : (
                            <span className="block italic">{result.judge_notes}</span>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
