import { Badge, Card, EmptyState, Table, TBody, Td, Th, THead, Tr } from '@velyric/ui';
import { ListChecks } from 'lucide-react';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { CursorPager } from '@/components/common/navigation';
import { ServiceDialog } from '@/components/scheduling/scheduling-forms';
import type { Page } from '@/lib/api-types';
import type { Location, Service } from '@/lib/api/scheduling';
import { formatMinor } from '@/lib/format';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';
import { searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('bookings.tabs');
  return { title: t('services') };
}

export default async function ServicesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'bookings:read');
  const [t, tr, locale] = await Promise.all([
    getTranslations('bookings.services'),
    getTranslations('bookings.resourceTypes'),
    getLocale(),
  ]);
  const [services, locations] = await Promise.all([
    serverGet<Page<Service>>('/services', {
      workspace: workspaceId,
      query: { limit: 100, cursor: searchValue(search['cursor']) },
    }),
    serverGet<{ data: Location[] }>('/locations', { workspace: workspaceId }),
  ]);
  const canWrite = permissions.has('bookings:write');
  const locationOptions = locations.data
    .filter((location) => location.status === 'ACTIVE')
    .map((location) => ({ id: location.id, name: location.name, timezone: location.timezone }));
  const locationNames = new Map(locations.data.map((location) => [location.id, location.name]));
  return (
    <div className="flex flex-col gap-4">
      {canWrite ? (
        <div className="flex justify-end">
          <ServiceDialog workspaceId={workspaceId} locations={locationOptions} />
        </div>
      ) : null}
      <Card className="overflow-hidden">
        {services.data.length === 0 ? (
          <EmptyState
            icon={<ListChecks className="h-5 w-5" aria-hidden="true" />}
            title={t('empty')}
            description={locationOptions.length === 0 ? t('needsLocation') : t('emptyDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('name')}</Th>
                  <Th>{t('location')}</Th>
                  <Th>{t('duration')}</Th>
                  <Th>{t('requiredResources')}</Th>
                  <Th>{t('price')}</Th>
                  <Th>{t('status')}</Th>
                  <Th>
                    <span className="sr-only">{t('edit')}</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {services.data.map((service) => (
                  <Tr key={service.id}>
                    <Td className="font-medium">{service.name}</Td>
                    <Td>{locationNames.get(service.location_id) ?? '–'}</Td>
                    <Td className="tabular-nums">
                      {t('minutes', { minutes: service.duration_minutes })}
                    </Td>
                    <Td>{service.required_resource_types.map((type) => tr(type)).join(', ')}</Td>
                    <Td className="tabular-nums">
                      {service.price_minor === null || service.currency === null
                        ? '–'
                        : formatMinor(service.price_minor, service.currency, locale)}
                    </Td>
                    <Td>
                      <Badge tone={service.active ? 'success' : 'neutral'}>
                        {service.active ? t('active') : t('inactive')}
                      </Badge>
                    </Td>
                    <Td className="text-right">
                      {canWrite ? (
                        <ServiceDialog
                          workspaceId={workspaceId}
                          locations={locationOptions}
                          service={service}
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
      <CursorPager nextCursor={services.page.next_cursor} />
    </div>
  );
}
