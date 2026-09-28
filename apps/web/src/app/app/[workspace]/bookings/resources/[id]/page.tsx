import { Badge, Card, CardContent, CardHeader, CardTitle } from '@velyric/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AvailabilityRulesEditor,
  DeleteExceptionButton,
  ExceptionDialog,
  ResourceDialog,
} from '@/components/scheduling/scheduling-forms';
import type { Page } from '@/lib/api-types';
import type { Integration } from '@/lib/api/integrations';
import type {
  AvailabilityException,
  AvailabilityRule,
  Location,
  Resource,
} from '@/lib/api/scheduling';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('bookings.tabs');
  return { title: t('resources') };
}

export default async function ResourceDetailPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: workspaceId, id } = await params;
  const { permissions } = await requirePermission(workspaceId, 'bookings:read');
  const [t, tr, format, locations, rules] = await Promise.all([
    getTranslations('bookings'),
    getTranslations('bookings.resourceTypes'),
    getFormatter(),
    serverGet<{ data: Location[] }>('/locations', { workspace: workspaceId }),
    serverGetOrNull<{ resource_id: string; rules: AvailabilityRule[] }>(
      `/resources/${id}/availability-rules`,
      { workspace: workspaceId },
    ),
  ]);
  const resources = await serverGet<Page<Resource>>('/resources', {
    workspace: workspaceId,
    query: { limit: 200 },
  });
  const resource = resources.data.find((entry) => entry.id === id);
  if (resource === undefined || rules === null) {
    notFound();
  }
  const location = locations.data.find((entry) => entry.id === resource.location_id);
  const timezone = location?.timezone ?? 'Europe/Budapest';
  const now = new Date();
  const horizon = new Date(now.getTime() + 180 * 86_400_000);
  const [exceptions, integrations] = await Promise.all([
    serverGet<Page<AvailabilityException>>('/availability-exceptions', {
      workspace: workspaceId,
      query: {
        location_id: resource.location_id,
        from: now.toISOString(),
        to: horizon.toISOString(),
        limit: 100,
      },
    }),
    permissions.has('integrations:read')
      ? serverGetOrNull<Page<Integration>>('/integrations', {
          workspace: workspaceId,
          query: { limit: 100 },
        })
      : Promise.resolve(null),
  ]);
  const relevant = exceptions.data.filter(
    (exception) => exception.resource_id === null || exception.resource_id === resource.id,
  );
  const canWrite = permissions.has('bookings:write');
  const calendars = (integrations?.data ?? [])
    .filter((integration) => integration.status === 'CONNECTED')
    .map((integration) => ({
      id: integration.id,
      name:
        integration.display_name ??
        integration.external_account_ref ??
        integration.integration_type,
    }));

  return (
    <div className="flex flex-col gap-4">
      <Link
        href={`/app/${workspaceId}/bookings/resources`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('resources.back')}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-text">{resource.name}</h2>
          <p className="text-sm text-text-muted">
            {tr(resource.resource_type)} · {location?.name ?? '–'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={resource.active ? 'success' : 'neutral'}>
            {resource.active ? t('resources.active') : t('resources.inactive')}
          </Badge>
          {canWrite ? (
            <ResourceDialog
              workspaceId={workspaceId}
              locations={
                location === undefined ? [] : [{ id: location.id, name: location.name, timezone }]
              }
              calendars={calendars}
              resource={resource}
            />
          ) : null}
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('availability.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <AvailabilityRulesEditor
              workspaceId={workspaceId}
              resource={resource}
              initial={rules.rules}
              timezone={timezone}
              timeZones={Intl.supportedValuesOf('timeZone')}
              canWrite={canWrite}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t('exceptions.title')}</CardTitle>
            {canWrite ? (
              <ExceptionDialog
                workspaceId={workspaceId}
                locationId={resource.location_id}
                resourceId={resource.id}
                timezone={timezone}
              />
            ) : null}
          </CardHeader>
          <CardContent>
            {relevant.length === 0 ? (
              <p className="text-sm text-text-muted">{t('exceptions.empty')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {relevant.map((exception) => (
                  <li key={exception.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-text">
                        {format.dateTimeRange(
                          new Date(exception.starts_at),
                          new Date(exception.ends_at),
                          { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone },
                        )}
                      </span>
                      <span className="text-xs text-text-muted">
                        {t(`exceptions.kinds.${exception.exception_kind}`)}
                        {exception.resource_id === null
                          ? ` · ${t('exceptions.wholeLocation')}`
                          : ''}
                        {exception.reason === null ? '' : ` · ${exception.reason}`}
                      </span>
                    </div>
                    {canWrite ? (
                      <DeleteExceptionButton workspaceId={workspaceId} exception={exception} />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
