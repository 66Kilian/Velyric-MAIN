import { Badge, Card, CardContent, CardHeader, CardTitle, DescriptionList } from '@velyric/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CancelBookingButton } from '@/components/scheduling/scheduling-forms';
import type { Booking, Location, Service } from '@/lib/api/scheduling';
import { BOOKING_TONES } from '@/lib/format';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('bookings');
  return { title: t('detail.title') };
}

export default async function BookingDetailPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: workspaceId, id } = await params;
  const { permissions, staffMode } = await requirePermission(workspaceId, 'bookings:read');
  const [t, te, format, booking] = await Promise.all([
    getTranslations('bookings'),
    getTranslations('enums'),
    getFormatter(),
    serverGetOrNull<Booking>(`/bookings/${id}`, { workspace: workspaceId }),
  ]);
  if (booking === null) {
    notFound();
  }
  const [service, locations] = await Promise.all([
    serverGetOrNull<Service>(`/services/${booking.service_id}`, { workspace: workspaceId }),
    serverGet<{ data: Location[] }>('/locations', { workspace: workspaceId }),
  ]);
  const location = locations.data.find((entry) => entry.id === booking.location_id);
  const dateTime = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), {
          dateStyle: 'full',
          timeStyle: 'short',
          timeZone: booking.timezone,
        });
  return (
    <div className="flex flex-col gap-4">
      <Link
        href={`/app/${workspaceId}/bookings`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('detail.back')}
      </Link>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-3">
            <span className="font-mono">{booking.reference}</span>
            <Badge tone={BOOKING_TONES[booking.status] ?? 'neutral'}>
              {te(`bookingStatus.${booking.status}`)}
            </Badge>
          </CardTitle>
          {permissions.has('bookings:write') &&
          (booking.status === 'CONFIRMED' || booking.status === 'PENDING_DEPOSIT') ? (
            <CancelBookingButton workspaceId={workspaceId} booking={booking} />
          ) : null}
        </CardHeader>
        <CardContent>
          <DescriptionList
            items={[
              { term: t('columns.service'), description: service?.name ?? '–' },
              { term: t('columns.location'), description: location?.name ?? '–' },
              { term: t('detail.starts'), description: dateTime(booking.starts_at) },
              { term: t('detail.ends'), description: dateTime(booking.ends_at) },
              { term: t('detail.timezone'), description: booking.timezone },
              {
                term: t('detail.partySize'),
                description: booking.party_size === null ? '–' : format.number(booking.party_size),
              },
              {
                term: t('columns.source'),
                description: t.has(`sources.${booking.source}`)
                  ? t(`sources.${booking.source}`)
                  : booking.source,
              },
              { term: t('detail.note'), description: booking.customer_note ?? '–' },
              { term: t('detail.deposit'), description: booking.deposit_status ?? '–' },
              { term: t('detail.calendarSync'), description: booking.external_sync_status ?? '–' },
              ...(staffMode && booking.call_id !== null
                ? [
                    {
                      term: t('detail.call'),
                      description: (
                        <Link
                          className="text-violet-text hover:underline"
                          href={`/admin/calls/${workspaceId}/${booking.call_id}`}
                        >
                          {t('detail.openCall')}
                        </Link>
                      ),
                    },
                  ]
                : []),
              {
                term: t('detail.canceled'),
                description:
                  booking.canceled_at === null
                    ? '–'
                    : `${dateTime(booking.canceled_at)} · ${booking.cancellation_reason ?? ''}`,
              },
              { term: t('detail.created'), description: dateTime(booking.created_at) },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
