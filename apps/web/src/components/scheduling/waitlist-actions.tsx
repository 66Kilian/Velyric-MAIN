'use client';

import { Button, Checkbox, Field, Input, NativeSelect } from '@velyric/ui';
import { CheckCircle2, Plus, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { FormDialog, useMutation } from '@/components/scheduling/scheduling-forms';
import { api } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import {
  WAITLIST_CHANNELS,
  type ContactListItem,
  type WaitlistChannel,
  type WaitlistEntry,
} from '@/lib/api/contacts';
import { zonedInstant, type Location, type Service } from '@/lib/api/scheduling';

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function CreateWaitlistEntryDialog({
  workspaceId,
  locations,
  services,
}: {
  readonly workspaceId: string;
  readonly locations: readonly Location[];
  readonly services: readonly Service[];
}) {
  const t = useTranslations('bookings.waitlist.form');
  const showError = useApiErrorToast();
  const { pending, run } = useMutation();
  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<readonly ContactListItem[] | null>(null);
  const [personId, setPersonId] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [serviceId, setServiceId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expires, setExpires] = useState('');
  const [partySize, setPartySize] = useState('1');
  const [channel, setChannel] = useState<WaitlistChannel>('SMS');
  const [consent, setConsent] = useState(false);
  const location = locations.find((entry) => entry.id === locationId);
  const zone = location?.timezone ?? 'UTC';
  const locationServices = services.filter(
    (service) => service.location_id === locationId && service.active,
  );
  const party = Number(partySize);
  const windowValid = LOCAL_DATE_TIME.test(from) && LOCAL_DATE_TIME.test(to) && to > from;
  const expiresValue = expires === '' ? to : expires;
  const valid =
    personId !== '' &&
    location !== undefined &&
    windowValid &&
    LOCAL_DATE_TIME.test(expiresValue) &&
    Number.isInteger(party) &&
    party >= 1 &&
    party <= 500 &&
    consent;

  const search = async () => {
    if (term.trim() === '') {
      return;
    }
    setSearching(true);
    try {
      const page = await api.get<Page<ContactListItem>>('/contacts', {
        workspace: workspaceId,
        query: { q: term.trim(), limit: 10 },
      });
      setCandidates(page.data);
      setPersonId(page.data[0]?.id ?? '');
    } catch (error) {
      showError(error);
    } finally {
      setSearching(false);
    }
  };

  return (
    <FormDialog
      trigger={
        <Button size="sm" disabled={locations.length === 0}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('open')}
        </Button>
      }
      title={t('title')}
      submitLabel={t('submit')}
      disabled={!valid}
      pending={pending}
      onSubmit={() =>
        run(
          () =>
            api.post('/waitlist', {
              workspace: workspaceId,
              body: {
                person_id: personId,
                location_id: locationId,
                ...(serviceId === '' ? {} : { service_id: serviceId }),
                desired_from: zonedInstant(from, zone),
                desired_to: zonedInstant(to, zone),
                expires_at: zonedInstant(expiresValue, zone),
                party_size: party,
                contact_channel: channel,
                contact_consent: true,
              },
            }),
          t('created'),
        )
      }
    >
      <Field id="waitlist-person-search" label={t('person')} required>
        <div className="flex gap-2">
          <Input
            id="waitlist-person-search"
            type="search"
            value={term}
            maxLength={120}
            placeholder={t('personPlaceholder')}
            onChange={(event) => {
              setTerm(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void search();
              }
            }}
          />
          <Button
            type="button"
            variant="secondary"
            loading={searching}
            disabled={searching || term.trim() === ''}
            onClick={() => {
              void search();
            }}
          >
            {t('find')}
          </Button>
        </div>
      </Field>
      {candidates === null ? null : candidates.length === 0 ? (
        <p className="text-sm text-text-muted">{t('noPeople')}</p>
      ) : (
        <NativeSelect
          aria-label={t('person')}
          value={personId}
          onChange={(event) => {
            setPersonId(event.target.value);
          }}
        >
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {[
                candidate.display_name ?? t('unnamed'),
                ...candidate.identities.map((identity) => identity.value),
              ].join(' · ')}
            </option>
          ))}
        </NativeSelect>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="waitlist-location" label={t('location')} required>
          <NativeSelect
            id="waitlist-location"
            value={locationId}
            onChange={(event) => {
              setLocationId(event.target.value);
              setServiceId('');
            }}
          >
            {locations.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="waitlist-service" label={t('service')}>
          <NativeSelect
            id="waitlist-service"
            value={serviceId}
            onChange={(event) => {
              setServiceId(event.target.value);
            }}
          >
            <option value="">{t('anyService')}</option>
            {locationServices.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="waitlist-from" label={t('from')} hint={zone} required>
          <Input
            id="waitlist-from"
            type="datetime-local"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
          />
        </Field>
        <Field
          id="waitlist-to"
          label={t('to')}
          required
          {...(from !== '' && to !== '' && !windowValid ? { error: t('windowInvalid') } : {})}
        >
          <Input
            id="waitlist-to"
            type="datetime-local"
            value={to}
            min={from}
            onChange={(event) => {
              setTo(event.target.value);
            }}
          />
        </Field>
        <Field id="waitlist-expires" label={t('expires')} hint={t('expiresHint')}>
          <Input
            id="waitlist-expires"
            type="datetime-local"
            value={expires}
            onChange={(event) => {
              setExpires(event.target.value);
            }}
          />
        </Field>
        <Field id="waitlist-party" label={t('partySize')}>
          <Input
            id="waitlist-party"
            type="number"
            min={1}
            max={500}
            value={partySize}
            onChange={(event) => {
              setPartySize(event.target.value);
            }}
          />
        </Field>
        <Field id="waitlist-channel" label={t('channel')}>
          <NativeSelect
            id="waitlist-channel"
            value={channel}
            onChange={(event) => {
              setChannel(event.target.value as WaitlistChannel);
            }}
          >
            {WAITLIST_CHANNELS.map((entry) => (
              <option key={entry} value={entry}>
                {t(`channels.${entry}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <label className="flex items-start gap-3 text-sm text-text">
        <Checkbox
          checked={consent}
          onCheckedChange={(value) => {
            setConsent(value === true);
          }}
        />
        <span>{t('consent')}</span>
      </label>
    </FormDialog>
  );
}

export function WaitlistEntryActions({
  workspaceId,
  entry,
}: {
  readonly workspaceId: string;
  readonly entry: WaitlistEntry;
}) {
  const t = useTranslations('bookings.waitlist.actions');
  const { run } = useMutation();
  const update = (status: 'FULFILLED' | 'CANCELED', message: string) =>
    run(
      () =>
        api.patch(`/waitlist/${entry.id}`, {
          workspace: workspaceId,
          ifMatch: entry.version,
          body: { status },
        }),
      message,
    );
  const canFulfill = entry.status === 'ACTIVE' || entry.status === 'ACCEPTED';
  const canCancel =
    entry.status === 'ACTIVE' ||
    entry.status === 'OFFERED' ||
    entry.status === 'ACCEPTED' ||
    entry.status === 'DECLINED';
  if (!canFulfill && !canCancel) {
    return null;
  }
  return (
    <div className="flex justify-end gap-1">
      {canFulfill ? (
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {t('fulfill')}
            </Button>
          }
          title={t('fulfillTitle')}
          description={t('fulfillDescription')}
          confirmLabel={t('fulfill')}
          onConfirm={() => update('FULFILLED', t('fulfilled'))}
        />
      ) : null}
      {canCancel ? (
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              {t('cancel')}
            </Button>
          }
          title={t('cancelTitle')}
          description={t('cancelDescription')}
          confirmLabel={t('cancel')}
          destructive
          onConfirm={() => update('CANCELED', t('canceled'))}
        />
      ) : null}
    </div>
  );
}
