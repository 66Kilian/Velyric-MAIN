import { Badge, Card, CardContent, PageHeader } from '@velyric/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LocationForm, LocationStatusActions } from '@/components/locations/location-forms';
import type { Location } from '@/lib/api/scheduling';
import { serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
}): Promise<Metadata> {
  const { workspace, id } = await params;
  const location = await serverGetOrNull<Location>(`/locations/${id}`, { workspace });
  const t = await getTranslations('navigation.app');
  return { title: location?.name ?? t('locations') };
}

export default async function LocationDetailPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: workspaceId, id } = await params;
  const { permissions } = await requirePermission(workspaceId, 'locations:read');
  const [t, location] = await Promise.all([
    getTranslations('locations'),
    serverGetOrNull<Location>(`/locations/${id}`, { workspace: workspaceId }),
  ]);
  if (location === null) {
    notFound();
  }
  const canManage = permissions.has('locations:manage');
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <Link
        href={`/app/${workspaceId}/locations`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('back')}
      </Link>
      <PageHeader
        title={location.name}
        description={
          t.has(`form.countries.${location.country}`)
            ? t(`form.countries.${location.country}`)
            : location.country
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {location.is_primary ? <Badge tone="pink">{t('primary')}</Badge> : null}
            <Badge tone={location.status === 'ACTIVE' ? 'success' : 'neutral'}>
              {t(`status.${location.status}`)}
            </Badge>
            {canManage ? (
              <LocationStatusActions workspaceId={workspaceId} location={location} />
            ) : null}
          </div>
        }
      />
      <Card>
        <CardContent className="pt-5">
          <LocationForm
            key={location.version}
            workspaceId={workspaceId}
            location={location}
            timezone={location.timezone}
            timeZones={Intl.supportedValuesOf('timeZone')}
            canManage={canManage}
          />
        </CardContent>
      </Card>
    </div>
  );
}
