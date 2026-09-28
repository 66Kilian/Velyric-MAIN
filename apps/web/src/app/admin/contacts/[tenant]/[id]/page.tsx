import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  type BadgeTone,
} from '@velyric/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  AddIdentityDialog,
  ContactProfileForm,
  ErasureDialog,
  ExportContactButton,
  MergeContactDialog,
  RemoveIdentityButton,
} from '@/components/contacts/contact-actions';
import { WAITLIST_TONES, type ContactDetail } from '@/lib/api/contacts';
import { BOOKING_TONES, clock, INTENT_TONES, OUTCOME_TONES } from '@/lib/format';
import { serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

const PRIVACY_TONES: Readonly<Record<string, BadgeTone>> = {
  RECEIVED: 'sky',
  VERIFYING: 'sky',
  IN_PROGRESS: 'warning',
  ON_LEGAL_HOLD: 'peach',
  COMPLETED: 'success',
  REJECTED: 'neutral',
};

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ tenant: string; id: string }>;
}): Promise<Metadata> {
  const { tenant: workspace, id } = await params;
  const [contact, t] = await Promise.all([
    serverGetOrNull<ContactDetail>(`/contacts/${id}`, { workspace }),
    getTranslations('contacts'),
  ]);
  return { title: contact?.display_name ?? t('unnamed') };
}

function Section({
  title,
  count,
  actions,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>
          {title}
          {count === undefined ? null : (
            <span className="ml-2 text-sm font-normal text-text-muted tabular-nums">{count}</span>
          )}
        </CardTitle>
        {actions}
      </CardHeader>
      {children}
    </Card>
  );
}

export default async function ContactDetailPage({
  params,
}: {
  readonly params: Promise<{ tenant: string; id: string }>;
}) {
  const { tenant: workspaceId, id } = await params;
  const { permissions } = await requirePermission(workspaceId, 'contacts:read');
  const [t, te, format, workspace, contact] = await Promise.all([
    getTranslations('contacts'),
    getTranslations('enums'),
    getFormatter(),
    getWorkspaceDetail(workspaceId),
    serverGetOrNull<ContactDetail>(`/contacts/${id}`, { workspace: workspaceId }),
  ]);
  if (contact === null) {
    notFound();
  }
  const canWrite = permissions.has('contacts:write');
  const timeZone = workspace.timezone;
  const when = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short', timeZone });
  const label = (group: string, value: string) =>
    t.has(`${group}.${value}`) ? t(`${group}.${value}`) : value;
  const openErasure = contact.privacy_requests.some(
    (request) =>
      request.request_type === 'DELETE' &&
      request.status !== 'COMPLETED' &&
      request.status !== 'REJECTED',
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <Link
        href={`/admin/contacts/${workspaceId}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('back')}
      </Link>
      <PageHeader
        title={contact.display_name ?? t('unnamed')}
        description={t('since', {
          date: format.dateTime(new Date(contact.created_at), { dateStyle: 'long', timeZone }),
        })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={contact.trust_level === 'VERIFIED' ? 'success' : 'neutral'}>
              {label('trust', contact.trust_level)}
            </Badge>
            {contact.shared_phone_suspected ? (
              <Badge tone="warning">{t('sharedPhone')}</Badge>
            ) : null}
            {permissions.has('contacts:export') ? (
              <ExportContactButton workspaceId={workspaceId} contactId={contact.id} />
            ) : null}
            {canWrite ? (
              <MergeContactDialog workspaceId={workspaceId} contactId={contact.id} />
            ) : null}
            {permissions.has('contacts:delete') && !openErasure ? (
              <ErasureDialog workspaceId={workspaceId} contactId={contact.id} />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Section title={t('profile.title')}>
          <CardContent>
            <ContactProfileForm
              key={contact.version}
              workspaceId={workspaceId}
              contact={contact}
              canWrite={canWrite}
            />
          </CardContent>
        </Section>

        <Section
          title={t('identities.title')}
          count={contact.identities.length}
          actions={
            canWrite ? (
              <AddIdentityDialog workspaceId={workspaceId} contactId={contact.id} />
            ) : undefined
          }
        >
          {contact.identities.length === 0 ? (
            <CardContent className="text-sm text-text-muted">{t('identities.empty')}</CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {contact.identities.map((identity) => (
                <li key={identity.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-text tabular-nums">
                      {identity.value}
                    </span>
                    <span className="text-xs text-text-muted">
                      {t(`identities.types.${identity.identity_type}`)} ·{' '}
                      {label('identities.states', identity.verification_state)} ·{' '}
                      {label('identities.sources', identity.source)}
                    </span>
                  </span>
                  {canWrite ? (
                    <RemoveIdentityButton
                      workspaceId={workspaceId}
                      contactId={contact.id}
                      identityId={identity.id}
                      value={identity.value}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title={t('calls.title')} count={contact.calls.length}>
        {contact.calls.length === 0 ? (
          <CardContent className="text-sm text-text-muted">{t('calls.empty')}</CardContent>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>{t('calls.started')}</Th>
                  <Th>{t('calls.channel')}</Th>
                  <Th>{t('calls.intent')}</Th>
                  <Th>{t('calls.outcome')}</Th>
                  <Th>{t('calls.duration')}</Th>
                </Tr>
              </THead>
              <TBody>
                {contact.calls.map((call) => (
                  <Tr key={call.id}>
                    <Td className="whitespace-nowrap">
                      {permissions.has('calls:read') ? (
                        <Link
                          href={`/admin/calls/${workspaceId}/${call.id}`}
                          className="font-medium text-text hover:text-pink-text hover:underline"
                        >
                          {when(call.started_at)}
                        </Link>
                      ) : (
                        when(call.started_at)
                      )}
                    </Td>
                    <Td>{te(`callChannel.${call.channel}`)}</Td>
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
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t('bookings.title')} count={contact.bookings.length}>
          {contact.bookings.length === 0 ? (
            <CardContent className="text-sm text-text-muted">{t('bookings.empty')}</CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {contact.bookings.map((booking) => (
                <li
                  key={booking.id}
                  className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
                >
                  {permissions.has('bookings:read') ? (
                    <Link
                      href={`/app/${workspaceId}/bookings/${booking.id}`}
                      className="font-medium text-text hover:text-pink-text hover:underline"
                    >
                      {format.dateTime(new Date(booking.starts_at), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: booking.timezone,
                      })}
                    </Link>
                  ) : (
                    <span className="font-medium">
                      {format.dateTime(new Date(booking.starts_at), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: booking.timezone,
                      })}
                    </span>
                  )}
                  <Badge tone={BOOKING_TONES[booking.status] ?? 'neutral'}>
                    {te(`bookingStatus.${booking.status}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t('waitlist.title')} count={contact.waitlist.length}>
          {contact.waitlist.length === 0 ? (
            <CardContent className="text-sm text-text-muted">{t('waitlist.empty')}</CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {contact.waitlist.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
                >
                  <span className="flex flex-col">
                    <span className="font-medium text-text">
                      {t('waitlist.added', { date: when(entry.created_at) })}
                    </span>
                    <span className="text-xs text-text-muted">
                      {t('waitlist.expires', { date: when(entry.expires_at) })}
                    </span>
                  </span>
                  <Badge tone={WAITLIST_TONES[entry.status]}>
                    {t(`waitlist.status.${entry.status}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t('consents.title')} count={contact.consents.length}>
          {contact.consents.length === 0 ? (
            <CardContent className="text-sm text-text-muted">{t('consents.empty')}</CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {contact.consents.map((consent) => (
                <li key={consent.id} className="flex flex-col gap-1 px-5 py-3 text-sm">
                  <span className="flex items-center justify-between gap-3">
                    <span className="font-medium text-text">
                      {when(consent.disclosure_delivered_at)}
                    </span>
                    <span className="text-xs uppercase text-text-muted">
                      {consent.disclosure_language} · {consent.disclosure_version}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Badge
                      tone={
                        consent.recording_consent === 'GRANTED'
                          ? 'success'
                          : consent.recording_consent === 'DENIED'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {t('consents.recording', {
                        state: label('consents.states', consent.recording_consent),
                      })}
                    </Badge>
                    {Object.entries(consent.contact_consent).flatMap(([channel, state]) =>
                      typeof state === 'string'
                        ? [
                            <Badge
                              key={channel}
                              tone={
                                state === 'GRANTED'
                                  ? 'success'
                                  : state === 'DENIED'
                                    ? 'danger'
                                    : 'neutral'
                              }
                            >
                              {t('consents.contact', {
                                channel: label('consents.channels', channel),
                                state: label('consents.states', state),
                              })}
                            </Badge>,
                          ]
                        : [],
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t('privacy.title')} count={contact.privacy_requests.length}>
          {contact.privacy_requests.length === 0 ? (
            <CardContent className="text-sm text-text-muted">{t('privacy.empty')}</CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {contact.privacy_requests.map((request) => (
                <li
                  key={request.id}
                  className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
                >
                  <span className="flex flex-col">
                    <span className="font-medium text-text">
                      {label('privacy.types', request.request_type)}
                    </span>
                    <span className="text-xs text-text-muted">
                      {t('privacy.due', { date: when(request.due_at) })}
                    </span>
                  </span>
                  <Badge tone={PRIVACY_TONES[request.status] ?? 'neutral'}>
                    {label('privacy.status', request.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
