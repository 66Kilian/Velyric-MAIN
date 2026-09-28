import {
  Badge,
  Button,
  Card,
  EmptyState,
  NativeSelect,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@velyric/ui';
import { ListOrdered } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CursorPager } from '@/components/common/navigation';
import {
  CreateWaitlistEntryDialog,
  WaitlistEntryActions,
} from '@/components/scheduling/waitlist-actions';
import type { Page } from '@/lib/api-types';
import { WAITLIST_STATUSES, WAITLIST_TONES, type WaitlistEntry } from '@/lib/api/contacts';
import type { Location, Service } from '@/lib/api/scheduling';
import { serverGet } from '@/server/api';
import { requirePermission } from '@/server/session';
import { searchValue } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('bookings.waitlist');
  return { title: t('title') };
}

export default async function WaitlistPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: workspaceId }, search] = await Promise.all([params, searchParams]);
  const { permissions } = await requirePermission(workspaceId, 'waitlist:read');
  const locationId = searchValue(search['location_id']);
  const requestedStatus = searchValue(search['status']);
  const status = WAITLIST_STATUSES.find((value) => value === requestedStatus);
  const [t, tc, format, locations, services, entries] = await Promise.all([
    getTranslations('bookings'),
    getTranslations('common.actions'),
    getFormatter(),
    serverGet<{ data: Location[] }>('/locations', { workspace: workspaceId }),
    serverGet<Page<Service>>('/services', { workspace: workspaceId, query: { limit: 200 } }),
    serverGet<Page<WaitlistEntry>>('/waitlist', {
      workspace: workspaceId,
      query: { limit: 50, cursor: searchValue(search['cursor']), location_id: locationId, status },
    }),
  ]);
  const serviceNames = new Map(services.data.map((service) => [service.id, service.name]));
  const locationsById = new Map(locations.data.map((location) => [location.id, location]));
  const canWrite = permissions.has('waitlist:write');
  const canSeeContacts = permissions.has('contacts:read');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex flex-wrap gap-3" aria-label={t('filters.label')}>
          <NativeSelect
            name="location_id"
            defaultValue={locationId ?? ''}
            aria-label={t('filters.location')}
          >
            <option value="">{t('filters.allLocations')}</option>
            {locations.data.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect name="status" defaultValue={status ?? ''} aria-label={t('filters.status')}>
            <option value="">{t('filters.allStatuses')}</option>
            {WAITLIST_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`waitlist.status.${value}`)}
              </option>
            ))}
          </NativeSelect>
          <Button type="submit" variant="secondary">
            {tc('filter')}
          </Button>
        </form>
        {canWrite && canSeeContacts ? (
          <CreateWaitlistEntryDialog
            workspaceId={workspaceId}
            locations={locations.data.filter((location) => location.status === 'ACTIVE')}
            services={services.data}
          />
        ) : null}
      </div>
      <Card className="overflow-hidden">
        {entries.data.length === 0 ? (
          <EmptyState
            icon={<ListOrdered className="h-5 w-5" aria-hidden="true" />}
            title={t('waitlist.empty')}
            description={t('waitlist.emptyDescription')}
            className="m-4 border-none"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('waitlist.columns.person')}</Th>
                  <Th>{t('waitlist.columns.window')}</Th>
                  <Th>{t('waitlist.columns.service')}</Th>
                  <Th>{t('waitlist.columns.party')}</Th>
                  <Th>{t('waitlist.columns.contact')}</Th>
                  <Th>{t('waitlist.columns.status')}</Th>
                  <Th>{t('waitlist.columns.expires')}</Th>
                  {canWrite ? (
                    <Th className="text-right">{t('waitlist.columns.actions')}</Th>
                  ) : null}
                </Tr>
              </THead>
              <TBody>
                {entries.data.map((entry) => {
                  const location = locationsById.get(entry.location_id);
                  const timeZone = location?.timezone;
                  const name = entry.person.display_name ?? t('waitlist.unnamed');
                  return (
                    <Tr key={entry.id}>
                      <Td>
                        <span className="flex flex-col">
                          <span className="font-medium">{name}</span>
                          <span className="text-xs text-text-muted">{location?.name ?? '–'}</span>
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {format.dateTimeRange(
                          new Date(entry.desired_from),
                          new Date(entry.desired_to),
                          {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                            ...(timeZone === undefined ? {} : { timeZone }),
                          },
                        )}
                      </Td>
                      <Td>
                        {entry.service_id === null
                          ? t('waitlist.anyService')
                          : (serviceNames.get(entry.service_id) ?? '–')}
                      </Td>
                      <Td className="tabular-nums">{entry.party_size}</Td>
                      <Td className="whitespace-nowrap">
                        <span className="flex flex-col">
                          <span>{t(`waitlist.form.channels.${entry.contact_channel}`)}</span>
                          <span className="text-xs text-text-muted tabular-nums">
                            {t('waitlist.attempts', {
                              used: entry.contact_attempts,
                              max: entry.max_contact_attempts,
                            })}
                          </span>
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={WAITLIST_TONES[entry.status]}>
                          {t(`waitlist.status.${entry.status}`)}
                        </Badge>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {format.dateTime(new Date(entry.expires_at), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                          ...(timeZone === undefined ? {} : { timeZone }),
                        })}
                      </Td>
                      {canWrite ? (
                        <Td>
                          <WaitlistEntryActions workspaceId={workspaceId} entry={entry} />
                        </Td>
                      ) : null}
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      <CursorPager nextCursor={entries.page.next_cursor} />
    </div>
  );
}
