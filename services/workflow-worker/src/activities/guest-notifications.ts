import { canonicalPersonId } from '@velyric/db';
import type { NotificationLocale } from '@velyric/notifications';
import type { CallerNotificationType } from '@velyric/notifications/caller';
import { sql } from 'kysely';
import type { GuestNotificationInput, NotifyInput } from '../workflows/types.js';
import { appendOutbox, inTenant, type ActivityDependencies, type Trx } from './support.js';

const LOCALES: readonly NotificationLocale[] = ['hu', 'de', 'en'];
const OFFER_HOLD_MINUTES = 29;

const EVENT_TYPES: Readonly<Record<GuestNotificationInput['eventType'], CallerNotificationType>> = {
  'booking.created': 'CALLER_BOOKING_CONFIRMATION',
  'booking.changed': 'CALLER_BOOKING_CHANGED',
  'booking.canceled': 'CALLER_BOOKING_CANCELED',
};

const INTL_LOCALES: Readonly<Record<NotificationLocale, string>> = {
  hu: 'hu-HU',
  de: 'de-DE',
  en: 'en-GB',
};

interface BookingDetails {
  readonly id: string;
  readonly status: string;
  readonly personId: string | null;
  readonly locationId: string;
  readonly serviceId: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timezone: string;
  readonly partySize: number;
  readonly customerNote: string | null;
  readonly rescheduledFrom: string | null;
  readonly serviceName: string;
  readonly locationName: string;
  readonly address: unknown;
}

interface GuestContact {
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly language: string | null;
}

export function formatDate(instant: Date, timezone: string, locale: NotificationLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    dateStyle: 'full',
    timeZone: timezone,
  }).format(instant);
}

export function formatTime(instant: Date, timezone: string, locale: NotificationLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  }).format(instant);
}

function formatAddress(address: unknown): string {
  if (typeof address !== 'object' || address === null) {
    return '';
  }
  const record = address as Record<string, unknown>;
  const text = (key: string): string => {
    const value = record[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  return [[text('postal_code'), text('city')].filter(Boolean).join(' '), text('line1')]
    .filter((part) => part !== '')
    .join(', ');
}

function nameFromNote(note: string | null): string {
  const line = note?.split('\n').find((entry) => entry.startsWith('Name: '));
  return line === undefined ? '' : line.slice('Name: '.length).trim();
}

export function bookingReference(bookingId: string): string {
  return bookingId.replaceAll('-', '').slice(-8).toUpperCase();
}

async function loadBooking(trx: Trx, bookingId: string): Promise<BookingDetails | null> {
  const row = await trx
    .selectFrom('bookings')
    .innerJoin('locations', 'locations.id', 'bookings.location_id')
    .leftJoin('services', 'services.id', 'bookings.service_id')
    .select([
      'bookings.id',
      'bookings.status',
      'bookings.person_id',
      'bookings.location_id',
      'bookings.service_id',
      'bookings.starts_at',
      'bookings.ends_at',
      'bookings.timezone',
      'bookings.party_size',
      'bookings.customer_note',
      'bookings.rescheduled_from_booking_id',
      'services.name as service_name',
      'locations.name as location_name',
      'locations.address',
    ])
    .where('bookings.id', '=', bookingId)
    .executeTakeFirst();
  return row === undefined
    ? null
    : {
        id: row.id,
        status: row.status,
        personId: row.person_id,
        locationId: row.location_id,
        serviceId: row.service_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        timezone: row.timezone,
        partySize: row.party_size,
        customerNote: row.customer_note,
        rescheduledFrom: row.rescheduled_from_booking_id,
        serviceName: row.service_name ?? '',
        locationName: row.location_name,
        address: row.address,
      };
}

async function loadGuest(
  trx: Trx,
  personId: string | null,
  fallbackName: string,
): Promise<GuestContact> {
  if (personId === null) {
    return { name: fallbackName, email: null, phone: null, language: null };
  }
  const canonical = await canonicalPersonId(trx, personId);
  const profile = await trx
    .selectFrom('caller_profiles')
    .select(['display_name', 'preferred_language'])
    .where('id', '=', canonical)
    .executeTakeFirst();
  const identities = await trx
    .selectFrom('person_identities')
    .select(['identity_type', 'normalized_value', 'verification_state', 'last_confirmed_at'])
    .where('person_id', '=', canonical)
    .where('identity_type', 'in', ['EMAIL', 'PHONE'])
    .orderBy(sql`case when verification_state = 'OBSERVED' then 1 else 0 end`)
    .orderBy('last_confirmed_at', (order) => order.desc().nullsLast())
    .execute();
  return {
    name: profile?.display_name ?? fallbackName,
    email:
      identities.find((identity) => identity.identity_type === 'EMAIL')?.normalized_value ?? null,
    phone:
      identities.find((identity) => identity.identity_type === 'PHONE')?.normalized_value ?? null,
    language: profile?.preferred_language ?? null,
  };
}

export async function workspaceNumber(trx: Trx, locationId: string | null): Promise<string | null> {
  const number = await trx
    .selectFrom('phone_numbers')
    .select(['e164'])
    .where('status', '=', 'ACTIVE')
    .orderBy(
      sql`case when location_id = ${locationId} then 0 when location_id is null then 1 else 2 end`,
    )
    .orderBy('created_at')
    .executeTakeFirst();
  return number?.e164 ?? null;
}

async function businessPhone(trx: Trx, locationId: string): Promise<string> {
  const number = await workspaceNumber(trx, locationId);
  if (number !== null) {
    return number;
  }
  const published = await trx
    .selectFrom('agents')
    .innerJoin('agent_versions', 'agent_versions.id', 'agents.production_version_id')
    .select(
      sql<string | null>`agent_versions.config #>> '{handoff,destinations,0,e164}'`.as('e164'),
    )
    .where('agents.status', '<>', 'ARCHIVED')
    .orderBy('agents.created_at', 'desc')
    .executeTakeFirst();
  return published?.e164 ?? '';
}

function localeFor(language: string | null, fallback: string): NotificationLocale {
  for (const candidate of [language?.slice(0, 2).toLowerCase(), fallback]) {
    const match = LOCALES.find((locale) => locale === candidate);
    if (match !== undefined) {
      return match;
    }
  }
  return 'hu';
}

function plan(
  input: { readonly tenantId: string; readonly traceId: string },
  type: CallerNotificationType,
  key: string,
  guest: GuestContact,
  smsEnabled: boolean,
  channels: readonly ('EMAIL' | 'SMS')[],
  payload: Readonly<Record<string, string>>,
  smsFrom: string | null,
): NotifyInput[] {
  const planned: NotifyInput[] = [];
  if (channels.includes('EMAIL') && guest.email !== null) {
    planned.push({
      tenantId: input.tenantId,
      type,
      channel: 'EMAIL',
      dedupeKey: `${key}:email`,
      payload: { ...payload, caller_email: guest.email },
      traceId: input.traceId,
    });
  }
  if (channels.includes('SMS') && smsEnabled && guest.phone !== null && smsFrom !== null) {
    planned.push({
      tenantId: input.tenantId,
      type,
      channel: 'SMS',
      dedupeKey: `${key}:sms`,
      payload: { ...payload, caller_phone: guest.phone, sms_from: smsFrom },
      traceId: input.traceId,
    });
  }
  return planned;
}

async function sharedContext(
  trx: Trx,
  booking: BookingDetails,
): Promise<{
  business: string;
  tenantLocale: string;
  phone: string;
  smsEnabled: boolean;
  smsFrom: string | null;
}> {
  const tenant = await trx
    .selectFrom('tenants')
    .select(['display_name', 'default_locale'])
    .executeTakeFirstOrThrow();
  const settings = await trx
    .selectFrom('tenant_messaging_settings')
    .select(['sms_enabled'])
    .executeTakeFirst();
  return {
    business: tenant.display_name,
    tenantLocale: tenant.default_locale,
    phone: await businessPhone(trx, booking.locationId),
    smsEnabled: settings?.sms_enabled ?? false,
    smsFrom: await workspaceNumber(trx, booking.locationId),
  };
}

function bookingPayload(
  booking: BookingDetails,
  guest: GuestContact,
  shared: { business: string; phone: string },
  locale: NotificationLocale,
): Record<string, string> {
  return {
    locale,
    business_name: shared.business,
    caller_name: guest.name,
    service_name: booking.serviceName,
    booking_date: formatDate(booking.startsAt, booking.timezone, locale),
    booking_time: formatTime(booking.startsAt, booking.timezone, locale),
    party_size: String(booking.partySize),
    location_name: booking.locationName,
    location_address: formatAddress(booking.address),
    business_phone: shared.phone,
    booking_reference: bookingReference(booking.id),
  };
}

export function createGuestNotificationActivities(deps: ActivityDependencies): {
  guestNotifications(input: GuestNotificationInput): Promise<readonly NotifyInput[]>;
  offerReleasedSlot(input: GuestNotificationInput): Promise<readonly NotifyInput[]>;
} {
  return {
    guestNotifications: (input) =>
      inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const booking = await loadBooking(trx, input.bookingId);
        const expected = input.eventType === 'booking.canceled' ? 'CANCELED' : 'CONFIRMED';
        if (booking?.status !== expected) {
          return [];
        }
        const guest = await loadGuest(trx, booking.personId, nameFromNote(booking.customerNote));
        const shared = await sharedContext(trx, booking);
        const locale = localeFor(guest.language, shared.tenantLocale);
        const payload = bookingPayload(booking, guest, shared, locale);
        if (input.eventType === 'booking.changed' && booking.rescheduledFrom !== null) {
          const previous = await loadBooking(trx, booking.rescheduledFrom);
          if (previous !== null) {
            payload['previous_date'] = formatDate(previous.startsAt, previous.timezone, locale);
            payload['previous_time'] = formatTime(previous.startsAt, previous.timezone, locale);
          }
        }
        const type = EVENT_TYPES[input.eventType];
        return plan(
          input,
          type,
          `guest:${type}:${booking.id}`,
          guest,
          shared.smsEnabled,
          ['EMAIL', 'SMS'],
          payload,
          shared.smsFrom,
        );
      }),

    offerReleasedSlot: (input) =>
      inTenant(deps, input.tenantId, input.traceId, async (trx) => {
        const current = await loadBooking(trx, input.bookingId);
        const freedId =
          input.eventType === 'booking.changed' ? current?.rescheduledFrom : current?.id;
        const freed =
          freedId === null || freedId === undefined ? null : await loadBooking(trx, freedId);
        if (freed?.status !== 'CANCELED' || freed.startsAt.getTime() <= deps.now().getTime()) {
          return [];
        }
        const holdKey = `waitlist-offer:${freed.id}`;
        const existing = await trx
          .selectFrom('booking_holds')
          .innerJoin('waitlist_offers', 'waitlist_offers.hold_id', 'booking_holds.id')
          .innerJoin('waitlist_entries', 'waitlist_entries.id', 'waitlist_offers.entry_id')
          .select([
            'waitlist_offers.id as offer_id',
            'waitlist_offers.expires_at',
            'waitlist_entries.person_id',
            'waitlist_entries.party_size',
            'waitlist_entries.contact_channel',
          ])
          .where('booking_holds.idempotency_key', '=', holdKey)
          .executeTakeFirst();
        let offer = existing;
        if (offer === undefined) {
          const entry = await trx
            .selectFrom('waitlist_entries')
            .select(['id', 'person_id', 'party_size', 'contact_channel', 'version'])
            .where('status', '=', 'ACTIVE')
            .where('location_id', '=', freed.locationId)
            .where((eb) =>
              eb.or([
                eb('service_id', 'is', null),
                ...(freed.serviceId === null ? [] : [eb('service_id', '=', freed.serviceId)]),
              ]),
            )
            .where('party_size', '<=', freed.partySize)
            .where('expires_at', '>', deps.now())
            .where(sql<boolean>`contact_attempts < max_contact_attempts`)
            .where(
              sql<boolean>`desired_window @> tstzrange(${freed.startsAt}, ${freed.endsAt}, '[)')`,
            )
            .orderBy('priority', 'desc')
            .orderBy('created_at')
            .limit(1)
            .forUpdate()
            .skipLocked()
            .executeTakeFirst();
          if (entry === undefined) {
            return [];
          }
          const hold = await trx
            .insertInto('booking_holds')
            .values({
              tenant_id: input.tenantId,
              location_id: freed.locationId,
              service_id: freed.serviceId,
              starts_at: freed.startsAt,
              ends_at: freed.endsAt,
              party_size: entry.party_size,
              status: 'ACTIVE',
              expires_at: sql<Date>`now() + make_interval(mins => ${OFFER_HOLD_MINUTES})`,
              idempotency_key: holdKey,
            })
            .returning(['id', 'expires_at'])
            .executeTakeFirstOrThrow();
          const created = await trx
            .insertInto('waitlist_offers')
            .values({
              tenant_id: input.tenantId,
              entry_id: entry.id,
              hold_id: hold.id,
              expires_at: hold.expires_at,
            })
            .returning(['id', 'expires_at'])
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('waitlist_entries')
            .set((eb) => ({
              status: 'OFFERED',
              contact_attempts: eb('contact_attempts', '+', 1),
              last_contacted_at: deps.now(),
              updated_at: deps.now(),
              version: eb('version', '+', 1),
            }))
            .where('id', '=', entry.id)
            .execute();
          await appendOutbox(
            trx,
            input.tenantId,
            'waitlist.slot_released',
            {
              waitlist_entry_id: entry.id,
              offer_id: created.id,
              hold_id: hold.id,
              released_booking_id: freed.id,
              location_id: freed.locationId,
              service_id: freed.serviceId,
              starts_at: freed.startsAt.toISOString(),
              ends_at: freed.endsAt.toISOString(),
              offer_expires_at: created.expires_at.toISOString(),
            },
            input.traceId,
          );
          offer = {
            offer_id: created.id,
            expires_at: created.expires_at,
            person_id: entry.person_id,
            party_size: entry.party_size,
            contact_channel: entry.contact_channel,
          };
        }
        const guest = await loadGuest(trx, offer.person_id, '');
        const shared = await sharedContext(trx, freed);
        const locale = localeFor(guest.language, shared.tenantLocale);
        const payload = {
          ...bookingPayload({ ...freed, partySize: offer.party_size }, guest, shared, locale),
          offer_expires_at: formatTime(offer.expires_at, freed.timezone, locale),
        };
        const channels =
          offer.contact_channel === 'EMAIL'
            ? (['EMAIL'] as const)
            : offer.contact_channel === 'SMS'
              ? (['SMS'] as const)
              : ([] as const);
        return plan(
          input,
          'CALLER_WAITLIST_OFFER',
          `guest:CALLER_WAITLIST_OFFER:${offer.offer_id}`,
          guest,
          shared.smsEnabled,
          channels,
          payload,
          shared.smsFrom,
        );
      }),
  };
}
