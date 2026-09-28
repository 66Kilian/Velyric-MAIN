import { Badge, Card, EmptyState, Table, TBody, Td, Th, THead, Tr } from '@velyric/ui';
import { Boxes } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { CursorPager } from '@/components/common/navigation';
import { ResourceDialog } from '@/components/scheduling/scheduling-forms';
import type { Page } from '@/lib/api-types';
import type { Integration } from '@/lib/api/integrations';
import type { Location, Resource } from '@/lib/api/scheduling';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('bookings.tabs');
  return { title: t('resources') };
}

export default async function ResourcesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'bookings:read');
  const [t, tr] = await Promise.all([
    getTranslations('bookings.resources'),
    getTranslations('bookings.resourceTypes'),
  ]);
  const [resources, locations, integrations] = await Promise.all([
    serverGet<Page<Resource>>('/resources', {
      workspace: workspaceId,
      query: { limit: 100, cursor: searchValue(search['cursor']) },
    }),
    serverGet<{ data: Location[] }>('/locations', { workspace: workspaceId }),
    permissions.has('integrations:read')
      ? serverGetOrNull<Page<Integration>>('/integrations', {
          workspace: workspaceId,
          query: { limit: 100 },
        })
      : Promise.resolve(null),
  ]);
  const canWrite = permissions.has('bookings:write');
  const locationOptions = locations.data
    .filter((location) => location.status === 'ACTIVE')
    .map((location) => ({ id: location.id, name: location.name, timezone: location.timezone }));
  const calendars = (integrations?.data ?? [])
    .filter((integration) => integration.status === 'CONNECTED')
    .map((integration) => ({
      id: integration.id,
      name:
        integration.display_name ??
        integration.external_account_ref ??
        integration.integration_type,
    }));
  const locationNames = new Map(locations.data.map((location) => [location.id, location.name]));
  return (
    <div className="flex flex-col gap-4">
      {canWrite ? (
        <div className="flex justify-end">
          <ResourceDialog
            workspaceId={workspaceId}
            locations={locationOptions}
            calendars={calendars}
          />
        </div>
      ) : null}
      <Card className="overflow-hidden">
        {resources.data.length === 0 ? (
          <EmptyState
            icon={<Boxes className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            description={t('emptyDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('name')}</Th>
                  <Th>{t('type')}</Th>
                  <Th>{t('location')}</Th>
                  <Th>{t('parallelSlots')}</Th>
                  <Th>{t('calendar')}</Th>
                  <Th>{t('status')}</Th>
                </Tr>
              </THead>
              <TBody>
                {resources.data.map((resource) => (
                  <Tr key={resource.id}>
                    <Td>
                      <Link
                        href={`/app/${workspaceId}/bookings/resources/${resource.id}`}
                        className="font-medium text-text hover:text-pink-text hover:underline"
                      >
                        {resource.name}
                      </Link>
                    </Td>
                    <Td>{tr(resource.resource_type)}</Td>
                    <Td>{locationNames.get(resource.location_id) ?? '–'}</Td>
                    <Td className="tabular-nums">{resource.parallel_slots}</Td>
                    <Td>
                      {resource.calendar_integration_id === null ? (
                        '–'
                      ) : (
                        <Badge tone="sky">{t('synced')}</Badge>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={resource.active ? 'success' : 'neutral'}>
                        {resource.active ? t('active') : t('inactive')}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      <CursorPager nextCursor={resources.page.next_cursor} />
    </div>
  );
}
