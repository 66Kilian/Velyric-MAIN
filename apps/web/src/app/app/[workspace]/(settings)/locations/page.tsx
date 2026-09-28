import { Badge, Card, EmptyState, PageHeader, Table, TBody, Td, Th, THead, Tr } from '@velyric/ui';
import { Building2 } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { CreateLocationDialog } from '@/components/locations/location-forms';
import type { Location } from '@/lib/api/scheduling';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('locations') };
}

export default async function LocationsPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'locations:read');
  const [t, workspace, locations] = await Promise.all([
    getTranslations('locations'),
    getWorkspaceDetail(workspaceId),
    serverGet<{ data: Location[] }>('/locations', { workspace: workspaceId }),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          permissions.has('locations:manage') ? (
            <CreateLocationDialog
              workspaceId={workspaceId}
              timezone={workspace.timezone}
              timeZones={Intl.supportedValuesOf('timeZone')}
            />
          ) : undefined
        }
      />
      <Card className="overflow-hidden">
        {locations.data.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-5 w-5" aria-hidden="true" />}
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
                  <Th>{t('columns.address')}</Th>
                  <Th>{t('columns.timezone')}</Th>
                  <Th>{t('columns.hours')}</Th>
                  <Th>{t('columns.status')}</Th>
                </Tr>
              </THead>
              <TBody>
                {locations.data.map((location) => (
                  <Tr key={location.id}>
                    <Td>
                      <Link
                        href={`/app/${workspaceId}/locations/${location.id}`}
                        className="font-medium text-text hover:text-pink-text hover:underline"
                      >
                        {location.name}
                      </Link>
                      {location.is_primary ? (
                        <Badge tone="pink" className="ml-2">
                          {t('primary')}
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="max-w-72 truncate text-text-muted">
                      {location.address === null
                        ? '–'
                        : `${location.address.postal_code} ${location.address.city}, ${location.address.line1}`}
                    </Td>
                    <Td>{location.timezone}</Td>
                    <Td className="tabular-nums">
                      {t('hoursCount', { count: location.business_hours.length })}
                    </Td>
                    <Td>
                      <Badge tone={location.status === 'ACTIVE' ? 'success' : 'neutral'}>
                        {t(`status.${location.status}`)}
                      </Badge>
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
