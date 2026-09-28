import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DescriptionList,
  EmptyState,
  PageHeader,
  StatusDot,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  cn,
} from '@velyric/ui';
import { ArrowLeft, FileText } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CallActions, type TransferDestination } from '@/components/calls/call-actions';
import { AutoRefresh } from '@/components/calls/call-filters';
import { CopyButton } from '@/components/common/navigation';
import { clock, INTENT_TONES, OUTCOME_TONES, STATUS_TONES, usdFromMicros } from '@/lib/format';
import type { CallDetail } from '@/lib/types';
import { serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('calls');
  return { title: t('detail.title') };
}

const ACTIVE = new Set(['INITIATED', 'QUEUED', 'IN_PROGRESS', 'TRANSFERRING']);

interface AgentVersionConfig {
  readonly agent_id: string;
  readonly version_number: number;
  readonly config?: {
    readonly handoff?: {
      readonly destinations?: readonly TransferDestination[];
      readonly warm_transfer?: boolean;
    };
  };
}

export default async function CallDetailPage({
  params,
}: {
  readonly params: Promise<{ tenant: string; id: string }>;
}) {
  const { tenant: workspaceId, id } = await params;
  const { permissions } = await requirePermission(workspaceId, 'calls:read');
  const [t, te, format, locale, workspace, call] = await Promise.all([
    getTranslations('calls'),
    getTranslations('enums'),
    getFormatter(),
    getLocale(),
    getWorkspaceDetail(workspaceId),
    serverGetOrNull<CallDetail>(`/calls/${id}`, { workspace: workspaceId }),
  ]);
  if (call === null) {
    notFound();
  }
  const active = ACTIVE.has(call.status);
  const version =
    active && call.agent_version_id !== null && permissions.has('agents:read')
      ? await serverGetOrNull<AgentVersionConfig>(`/agent-versions/${call.agent_version_id}`, {
          workspace: workspaceId,
        })
      : null;
  const zone = workspace.timezone;
  const dateTime = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), {
          dateStyle: 'medium',
          timeStyle: 'medium',
          timeZone: zone,
        });
  const startedMs = Date.parse(call.started_at);

  return (
    <div className="flex flex-col gap-6">
      {active ? <AutoRefresh intervalMs={4000} /> : null}
      <Link
        href={`/admin/calls/${workspaceId}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('detail.back')}
      </Link>
      <PageHeader
        eyebrow={te(`callChannel.${call.channel}`)}
        title={
          call.caller_e164 ?? (call.channel === 'WEB_VOICE' ? t('webVisitor') : t('unknownCaller'))
        }
        description={dateTime(call.started_at)}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={STATUS_TONES[call.status] ?? 'neutral'}>
              {active ? (
                <StatusDot pulse tone={call.status === 'TRANSFERRING' ? 'warning' : 'success'} />
              ) : null}
              {te(`callStatus.${call.status}`)}
            </Badge>
            {active ? (
              <CallActions
                workspaceId={workspaceId}
                callId={call.id}
                canTransfer={permissions.has('calls:transfer')}
                canTerminate={permissions.has('calls:terminate')}
                destinations={version?.config?.handoff?.destinations ?? []}
                warmTransferAvailable={version?.config?.handoff?.warm_transfer ?? true}
              />
            ) : null}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t('detail.summary')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              {call.intent === null ? null : (
                <Badge tone={INTENT_TONES[call.intent] ?? 'neutral'}>
                  {te(`callIntent.${call.intent}`)}
                </Badge>
              )}
              {call.outcome === null ? null : (
                <Badge tone={OUTCOME_TONES[call.outcome] ?? 'neutral'}>
                  {te(`callOutcome.${call.outcome}`)}
                </Badge>
              )}
            </div>
            {permissions.has('calls:read_transcript') ? (
              <p className="text-[15px] leading-relaxed text-text">
                {call.summary ?? t('detail.noSummary')}
              </p>
            ) : (
              <p className="text-sm text-text-muted">{t('detail.summaryRestricted')}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.facts')}</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                {
                  term: t('detail.direction'),
                  description:
                    call.direction === 'INBOUND' ? t('filters.inbound') : t('filters.outbound'),
                },
                { term: t('columns.language'), description: call.language?.toUpperCase() ?? '–' },
                {
                  term: t('columns.agent'),
                  description:
                    call.agent_id === null ? (
                      '–'
                    ) : (
                      <Link
                        className="text-violet-text hover:underline"
                        href={`/app/${workspaceId}/agents/${call.agent_id}`}
                      >
                        {t('detail.openAgent')}
                      </Link>
                    ),
                },
                {
                  term: t('columns.duration'),
                  description: call.duration_seconds === null ? '–' : clock(call.duration_seconds),
                },
                {
                  term: t('detail.billable'),
                  description: call.billable_seconds === null ? '–' : clock(call.billable_seconds),
                },
                {
                  term: t('detail.cost'),
                  description:
                    call.cost_usd_micros === null
                      ? '–'
                      : usdFromMicros(call.cost_usd_micros, locale),
                },
                { term: t('detail.answered'), description: dateTime(call.answered_at) },
                { term: t('detail.ended'), description: dateTime(call.ended_at) },
                {
                  term: t('detail.endReason'),
                  description:
                    call.end_reason === null ? '–' : te(`callEndReason.${call.end_reason}`),
                },
                {
                  term: t('detail.quality'),
                  description:
                    call.quality === null
                      ? call.quality_score === null
                        ? '–'
                        : format.number(call.quality_score, { maximumFractionDigits: 1 })
                      : `${format.number(call.quality.overall_score, { maximumFractionDigits: 0 })}/100`,
                },
                {
                  term: t('detail.trace'),
                  description:
                    call.trace_id === null ? (
                      '–'
                    ) : (
                      <span className="flex items-center gap-1">
                        <code className="truncate font-mono text-xs">{call.trace_id}</code>
                        <CopyButton value={call.trace_id} label={t('detail.copyTrace')} />
                      </span>
                    ),
                },
              ]}
            />
            {call.quality !== null && call.quality.flags.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {call.quality.flags.map((flag) => (
                  <Badge key={flag} tone="warning">
                    {flag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t('detail.transcript')}</CardTitle>
          </CardHeader>
          <CardContent>
            {call.transcript === null ? (
              <p className="text-sm text-text-muted">{t('detail.transcriptRestricted')}</p>
            ) : call.transcript.length === 0 ? (
              <EmptyState
                icon={<FileText className="h-5 w-5" aria-hidden="true" />}
                title={t('detail.transcriptEmpty')}
                className="border-none py-8"
              />
            ) : (
              <ol className="flex flex-col gap-3" aria-live={active ? 'polite' : undefined}>
                {call.transcript.map((segment) => {
                  const caller = segment.speaker === 'CALLER';
                  return (
                    <li
                      key={segment.seq}
                      className={cn('flex flex-col gap-1', caller ? 'items-start' : 'items-end')}
                    >
                      <span className="text-xs text-text-muted">
                        {t(`speakers.${segment.speaker}`)} ·{' '}
                        <span className="tabular-nums">{clock(segment.start_ms / 1000)}</span>
                      </span>
                      <p
                        className={cn(
                          'max-w-[85%] rounded-lg px-3.5 py-2.5 text-[15px] leading-relaxed',
                          caller
                            ? 'rounded-tl-sm bg-surface-muted text-text'
                            : 'rounded-tr-sm bg-pink-tint text-text',
                        )}
                      >
                        {segment.content}
                        {segment.redaction_state === 'REDACTED' ? (
                          <Badge tone="neutral" className="ml-2 align-middle">
                            {t('detail.redacted')}
                          </Badge>
                        ) : null}
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.timeline')}</CardTitle>
          </CardHeader>
          <CardContent>
            {call.events.length === 0 ? (
              <p className="text-sm text-text-muted">{t('detail.noEvents')}</p>
            ) : (
              <ol className="relative flex flex-col gap-3 border-l border-border pl-4">
                {call.events.map((event) => (
                  <li key={event.seq} className="relative">
                    <span
                      className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-pink"
                      aria-hidden="true"
                    />
                    <p className="font-mono text-xs text-text">{event.type}</p>
                    <p className="text-xs tabular-nums text-text-muted">
                      +{clock((Date.parse(event.occurred_at) - startedMs) / 1000)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>{t('detail.tools')}</CardTitle>
        </CardHeader>
        {call.tool_runs.length === 0 ? (
          <CardContent>
            <p className="text-sm text-text-muted">{t('detail.noTools')}</p>
          </CardContent>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('detail.tool')}</Th>
                  <Th>{t('detail.specialist')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('detail.latency')}</Th>
                  <Th>{t('detail.time')}</Th>
                </Tr>
              </THead>
              <TBody>
                {call.tool_runs.map((run) => (
                  <Tr key={run.id}>
                    <Td className="font-mono text-xs">{run.tool}</Td>
                    <Td>{run.specialist ?? '–'}</Td>
                    <Td>
                      <Badge
                        tone={
                          run.status === 'SUCCEEDED'
                            ? 'success'
                            : run.status === 'FAILED' || run.status === 'DENIED'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {run.status}
                      </Badge>
                      {run.error_code === null ? null : (
                        <span className="ml-2 font-mono text-xs text-danger-text">
                          {run.error_code}
                        </span>
                      )}
                    </Td>
                    <Td className="tabular-nums">
                      {run.latency_ms === null ? '–' : `${format.number(run.latency_ms)} ms`}
                    </Td>
                    <Td className="whitespace-nowrap">{dateTime(run.created_at)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>

      {call.transfers.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>{t('detail.transfers')}</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('actions.destination')}</Th>
                  <Th>{t('actions.transferType')}</Th>
                  <Th>{t('detail.trigger')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('detail.time')}</Th>
                </Tr>
              </THead>
              <TBody>
                {call.transfers.map((transfer) => (
                  <Tr key={transfer.id}>
                    <Td className="font-mono text-xs">{transfer.destination_label}</Td>
                    <Td>
                      {transfer.transfer_type === 'WARM' ? t('actions.warm') : t('actions.cold')}
                    </Td>
                    <Td>{transfer.trigger}</Td>
                    <Td>
                      <Badge
                        tone={
                          transfer.state === 'COMPLETED'
                            ? 'success'
                            : transfer.state === 'FAILED'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {transfer.state}
                      </Badge>
                      {transfer.failure_reason === null ? null : (
                        <span className="ml-2 text-xs text-danger-text">
                          {transfer.failure_reason}
                        </span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">{dateTime(transfer.started_at)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
