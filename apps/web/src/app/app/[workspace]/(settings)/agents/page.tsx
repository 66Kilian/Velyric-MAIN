import { Badge, Card, EmptyState, PageHeader, Table, TBody, Td, Th, THead, Tr } from '@velyric/ui';
import { Bot } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { CreateAgentDialog } from '@/components/agents/agent-actions';
import { CursorPager } from '@/components/common/navigation';
import type { Page } from '@/lib/api-types';
import type { Agent, PhoneNumber } from '@/lib/api/agents';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail, searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('agents') };
}

const STATUS_TONE = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  PAUSED: 'warning',
  ARCHIVED: 'neutral',
} as const;

export default async function AgentsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'agents:read');
  const [t, te, format, workspace] = await Promise.all([
    getTranslations('agents'),
    getTranslations('enums'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
  ]);
  const [agents, numbers, locations] = await Promise.all([
    serverGet<Page<Agent>>('/agents', {
      workspace: workspaceId,
      query: { limit: 50, cursor: searchValue(search['cursor']) },
    }),
    permissions.has('phone_numbers:read')
      ? serverGetOrNull<{ data: PhoneNumber[] }>('/phone-numbers', { workspace: workspaceId })
      : Promise.resolve(null),
    permissions.has('locations:read')
      ? serverGetOrNull<{ data: { id: string; name: string }[] }>('/locations', {
          workspace: workspaceId,
        })
      : Promise.resolve(null),
  ]);
  const numbersByAgent = new Map<string, string[]>();
  for (const number of numbers?.data ?? []) {
    if (number.agent !== null) {
      numbersByAgent.set(number.agent.id, [
        ...(numbersByAgent.get(number.agent.id) ?? []),
        number.e164,
      ]);
    }
  }
  const locationNames = new Map(
    (locations?.data ?? []).map((location) => [location.id, location.name]),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          permissions.has('agents:write') ? (
            <CreateAgentDialog workspaceId={workspaceId} locations={locations?.data ?? []} />
          ) : undefined
        }
      />
      <Card className="overflow-hidden">
        {agents.data.length === 0 ? (
          <EmptyState
            icon={<Bot className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            description={t('emptyDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('columns.name')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.release')}</Th>
                  <Th>{t('columns.numbers')}</Th>
                  <Th>{t('columns.location')}</Th>
                  <Th>{t('columns.updated')}</Th>
                </Tr>
              </THead>
              <TBody>
                {agents.data.map((agent) => (
                  <Tr key={agent.id}>
                    <Td>
                      <Link
                        href={`/app/${workspaceId}/agents/${agent.id}`}
                        className="font-medium text-text hover:text-pink-text hover:underline"
                      >
                        {agent.name}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[agent.status]}>
                        {te(`agentStatus.${agent.status}`)}
                      </Badge>
                    </Td>
                    <Td>
                      {agent.production_version_id === null ? (
                        <span className="text-text-muted">{t('notPublished')}</span>
                      ) : (
                        <Badge tone="violet">
                          {agent.canary_version_id === null ? t('production') : t('canaryRunning')}
                        </Badge>
                      )}
                    </Td>
                    <Td className="tabular-nums">
                      {(numbersByAgent.get(agent.id) ?? []).join(', ') || '–'}
                    </Td>
                    <Td>
                      {agent.location_id === null
                        ? t('allLocations')
                        : (locationNames.get(agent.location_id) ?? '–')}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {format.dateTime(new Date(agent.updated_at), {
                        dateStyle: 'medium',
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
      <CursorPager nextCursor={agents.page.next_cursor} />
    </div>
  );
}
