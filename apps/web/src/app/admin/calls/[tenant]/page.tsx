import { Badge, Card, EmptyState, PageHeader, Table, TBody, Td, Th, THead, Tr } from '@velyric/ui';
import { PhoneCall } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AutoRefresh, CallFilters } from '@/components/calls/call-filters';
import { CursorPager } from '@/components/common/navigation';
import type { Page } from '@/lib/api-types';
import { addDays } from '@/lib/dates';
import { clock, INTENT_TONES, OUTCOME_TONES, STATUS_TONES } from '@/lib/format';
import type { CallListItem } from '@/lib/types';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('calls') };
}

function zonedMidnightIso(day: string | undefined, timeZone: string): string | undefined {
  if (day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return undefined;
  }
  const utc = new Date(`${day}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(utc);
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value.replace('GMT', '') ?? '';
  const normalized = offset === '' ? '+00:00' : offset;
  return new Date(`${day}T00:00:00${normalized}`).toISOString();
}

export default async function CallsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ tenant: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ tenant: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'calls:read');
  const [t, te, format, workspace] = await Promise.all([
    getTranslations('calls'),
    getTranslations('enums'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
  ]);
  const status = searchValue(search['status']);
  const toDay = searchValue(search['to']);
  const query = {
    status,
    direction: searchValue(search['direction']),
    channel: searchValue(search['channel']),
    agent_id: searchValue(search['agent_id']),
    language: searchValue(search['language']),
    outcome: searchValue(search['outcome']),
    from: zonedMidnightIso(searchValue(search['from']), workspace.timezone),
    to: toDay === undefined ? undefined : zonedMidnightIso(addDays(toDay, 1), workspace.timezone),
    cursor: searchValue(search['cursor']),
    limit: 50,
  };
  const [calls, agents] = await Promise.all([
    serverGet<Page<CallListItem>>('/calls', { workspace: workspaceId, query }),
    permissions.has('agents:read')
      ? serverGetOrNull<Page<{ id: string; name: string }>>('/agents', {
          workspace: workspaceId,
          query: { limit: 200 },
        })
      : Promise.resolve(null),
  ]);
  const agentNames = new Map((agents?.data ?? []).map((agent) => [agent.id, agent.name]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      {status === 'ACTIVE' ? <AutoRefresh intervalMs={5000} /> : null}
      <CallFilters agents={agents?.data ?? []} />
      <Card className="overflow-hidden">
        {calls.data.length === 0 ? (
          <EmptyState
            icon={<PhoneCall className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            description={t('emptyDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.started')}</Th>
                  <Th>{t('columns.caller')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.intent')}</Th>
                  <Th>{t('columns.outcome')}</Th>
                  <Th>{t('columns.duration')}</Th>
                  <Th>{t('columns.language')}</Th>
                  <Th>{t('columns.agent')}</Th>
                </Tr>
              </THead>
              <TBody>
                {calls.data.map((call) => (
                  <Tr key={call.id}>
                    <Td className="whitespace-nowrap">
                      <Link
                        href={`/admin/calls/${workspaceId}/${call.id}`}
                        className="font-medium text-text hover:text-pink-text hover:underline"
                      >
                        {format.dateTime(new Date(call.started_at), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                          timeZone: workspace.timezone,
                        })}
                      </Link>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">
                      <span className="flex flex-col">
                        <span>
                          {call.caller_e164 ??
                            (call.channel === 'WEB_VOICE' ? t('webVisitor') : t('unknownCaller'))}
                        </span>
                        <span className="text-xs text-text-muted">
                          {te(`callChannel.${call.channel}`)}
                        </span>
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONES[call.status] ?? 'neutral'}>
                        {te(`callStatus.${call.status}`)}
                      </Badge>
                    </Td>
                    <Td>
                      {call.intent === null ? (
                        '–'
                      ) : (
                        <Badge tone={INTENT_TONES[call.intent] ?? 'neutral'}>
                          {te(`callIntent.${call.intent}`)}
                        </Badge>
                      )}
                    </Td>
                    <Td>
                      {call.outcome === null ? (
                        '–'
                      ) : (
                        <Badge tone={OUTCOME_TONES[call.outcome] ?? 'neutral'}>
                          {te(`callOutcome.${call.outcome}`)}
                        </Badge>
                      )}
                    </Td>
                    <Td className="tabular-nums">
                      {call.duration_seconds === null ? '–' : clock(call.duration_seconds)}
                    </Td>
                    <Td className="uppercase">{call.language ?? '–'}</Td>
                    <Td className="max-w-40 truncate">
                      {call.agent_id === null
                        ? '–'
                        : (agentNames.get(call.agent_id) ?? t('unknownAgent'))}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      <CursorPager nextCursor={calls.page.next_cursor} />
    </div>
  );
}
