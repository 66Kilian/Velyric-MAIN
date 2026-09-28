'use client';

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTrigger,
  Field,
  Input,
  NativeSelect,
  Textarea,
  useToast,
} from '@velyric/ui';
import { Pencil, Plus, Trash2, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import {
  RESOURCE_TYPES,
  zonedInstant,
  type AvailabilityException,
  type AvailabilityRule,
  type Booking,
  type Currency,
  type Resource,
  type ResourceKind,
  type Service,
} from '@/lib/api/scheduling';

interface LocationOption {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
}

export function useMutation() {
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [pending, setPending] = useState(false);
  const run = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    setPending(true);
    try {
      await action();
      notify({ tone: 'success', title: success });
      router.refresh();
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}

export function FormDialog({
  trigger,
  title,
  children,
  submitLabel,
  disabled,
  pending,
  onSubmit,
}: {
  readonly trigger: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
  readonly submitLabel: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onSubmit: () => Promise<boolean>;
}) {
  const tc = useTranslations('common.actions');
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent title={title} closeLabel={tc('close')}>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await onSubmit()) {
              setOpen(false);
            }
          }}
        >
          {children}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setOpen(false);
              }}
            >
              {tc('cancel')}
            </Button>
            <Button type="submit" loading={pending} disabled={pending || disabled}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function toMinor(value: string): number | null {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed === '') {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
}

export function ServiceDialog({
  workspaceId,
  locations,
  service,
}: {
  readonly workspaceId: string;
  readonly locations: readonly LocationOption[];
  readonly service?: Service;
}) {
  const t = useTranslations('bookings.services');
  const te = useTranslations('bookings.resourceTypes');
  const { pending, run } = useMutation();
  const [locationId, setLocationId] = useState(service?.location_id ?? locations[0]?.id ?? '');
  const [name, setName] = useState(service?.name ?? '');
  const [duration, setDuration] = useState(service?.duration_minutes ?? 30);
  const [bufferBefore, setBufferBefore] = useState(service?.buffer_before_minutes ?? 0);
  const [bufferAfter, setBufferAfter] = useState(service?.buffer_after_minutes ?? 0);
  const [types, setTypes] = useState<ResourceKind[]>([
    ...(service?.required_resource_types ?? ['EMPLOYEE']),
  ]);
  const [cancellation, setCancellation] = useState(
    service?.cancellation_window_minutes === null || service === undefined
      ? ''
      : String(service.cancellation_window_minutes),
  );
  const [price, setPrice] = useState(
    service?.price_minor === null || service === undefined ? '' : String(service.price_minor / 100),
  );
  const [currency, setCurrency] = useState<Currency>(service?.currency ?? 'HUF');
  const [active, setActive] = useState(service?.active ?? true);
  const valid =
    locationId !== '' &&
    name.trim() !== '' &&
    duration >= 5 &&
    duration <= 1440 &&
    types.length >= 1 &&
    bufferBefore >= 0 &&
    bufferAfter >= 0 &&
    (price.trim() === '' || toMinor(price) !== null);

  const submit = () => {
    const cancellationMinutes = cancellation.trim() === '' ? undefined : Number(cancellation);
    const common = {
      name: name.trim(),
      duration_minutes: duration,
      buffer_before_minutes: bufferBefore,
      buffer_after_minutes: bufferAfter,
      required_resource_types: types,
      ...(cancellationMinutes === undefined
        ? {}
        : { cancellation_window_minutes: cancellationMinutes }),
    };
    if (service === undefined) {
      const priceMinor = toMinor(price);
      return run(
        () =>
          api.post('/services', {
            workspace: workspaceId,
            body: {
              ...common,
              location_id: locationId,
              ...(priceMinor === null ? {} : { price_minor: priceMinor, currency }),
            },
          }),
        t('created'),
      );
    }
    return run(
      () =>
        api.patch(`/services/${service.id}`, {
          workspace: workspaceId,
          ifMatch: service.version,
          body: { ...common, active },
        }),
      t('saved'),
    );
  };

  return (
    <FormDialog
      trigger={
        service === undefined ? (
          <Button disabled={locations.length === 0}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('create')}
          </Button>
        ) : (
          <Button variant="ghost" size="sm">
            <Pencil className="h-4 w-4" aria-hidden="true" />
            {t('edit')}
          </Button>
        )
      }
      title={service === undefined ? t('create') : t('editTitle', { name: service.name })}
      submitLabel={service === undefined ? t('create') : t('save')}
      disabled={!valid}
      pending={pending}
      onSubmit={submit}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="service-name" label={t('name')} required className="md:col-span-2">
          <Input
            id="service-name"
            value={name}
            maxLength={160}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        {service === undefined ? (
          <Field id="service-location" label={t('location')} required>
            <NativeSelect
              id="service-location"
              value={locationId}
              onChange={(event) => {
                setLocationId(event.target.value);
              }}
            >
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        <Field id="service-duration" label={t('duration')} required>
          <Input
            id="service-duration"
            type="number"
            min={5}
            max={1440}
            step={5}
            value={duration}
            onChange={(event) => {
              setDuration(Number(event.target.value));
            }}
          />
        </Field>
        <Field id="service-buffer-before" label={t('bufferBefore')}>
          <Input
            id="service-buffer-before"
            type="number"
            min={0}
            max={240}
            value={bufferBefore}
            onChange={(event) => {
              setBufferBefore(Number(event.target.value));
            }}
          />
        </Field>
        <Field id="service-buffer-after" label={t('bufferAfter')}>
          <Input
            id="service-buffer-after"
            type="number"
            min={0}
            max={240}
            value={bufferAfter}
            onChange={(event) => {
              setBufferAfter(Number(event.target.value));
            }}
          />
        </Field>
        <Field
          id="service-cancellation"
          label={t('cancellationWindow')}
          hint={t('cancellationHint')}
        >
          <Input
            id="service-cancellation"
            type="number"
            min={0}
            max={20160}
            value={cancellation}
            onChange={(event) => {
              setCancellation(event.target.value);
            }}
          />
        </Field>
        {service === undefined ? (
          <div className="grid grid-cols-[2fr_1fr] gap-2">
            <Field id="service-price" label={t('price')}>
              <Input
                id="service-price"
                inputMode="decimal"
                value={price}
                onChange={(event) => {
                  setPrice(event.target.value);
                }}
              />
            </Field>
            <Field id="service-currency" label={t('currency')}>
              <NativeSelect
                id="service-currency"
                value={currency}
                onChange={(event) => {
                  setCurrency(event.target.value as Currency);
                }}
              >
                <option value="HUF">HUF</option>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
              </NativeSelect>
            </Field>
          </div>
        ) : null}
      </div>
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-text">{t('requiredResources')}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {RESOURCE_TYPES.map((type) => (
            <label key={type} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={types.includes(type)}
                disabled={!types.includes(type) && types.length >= 4}
                onCheckedChange={(value) => {
                  setTypes((current) =>
                    value === true ? [...current, type] : current.filter((entry) => entry !== type),
                  );
                }}
              />
              {te(type)}
            </label>
          ))}
        </div>
      </fieldset>
      {service === undefined ? null : (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={active}
            onCheckedChange={(value) => {
              setActive(value === true);
            }}
          />
          {t('active')}
        </label>
      )}
    </FormDialog>
  );
}

export function ResourceDialog({
  workspaceId,
  locations,
  calendars,
  resource,
}: {
  readonly workspaceId: string;
  readonly locations: readonly LocationOption[];
  readonly calendars: readonly { readonly id: string; readonly name: string }[];
  readonly resource?: Resource;
}) {
  const t = useTranslations('bookings.resources');
  const te = useTranslations('bookings.resourceTypes');
  const { pending, run } = useMutation();
  const [locationId, setLocationId] = useState(resource?.location_id ?? locations[0]?.id ?? '');
  const [name, setName] = useState(resource?.name ?? '');
  const [type, setType] = useState<ResourceKind>(resource?.resource_type ?? 'EMPLOYEE');
  const [slots, setSlots] = useState(resource?.parallel_slots ?? 1);
  const [seats, setSeats] = useState(
    resource?.seat_capacity === null || resource === undefined
      ? ''
      : String(resource.seat_capacity),
  );
  const [calendarId, setCalendarId] = useState(resource?.calendar_integration_id ?? '');
  const [calendarRef, setCalendarRef] = useState(resource?.external_calendar_ref ?? '');
  const [active, setActive] = useState(resource?.active ?? true);
  const [calendarOptions, setCalendarOptions] = useState<
    readonly { readonly id: string; readonly name: string; readonly primary: boolean }[] | null
  >(null);
  const [calendarOptionsError, setCalendarOptionsError] = useState(false);
  const [calendarOptionsLoading, setCalendarOptionsLoading] = useState(false);
  useEffect(() => {
    if (calendarId === '') {
      setCalendarOptions(null);
      setCalendarOptionsError(false);
      return;
    }
    let alive = true;
    setCalendarOptionsLoading(true);
    setCalendarOptionsError(false);
    api
      .get<{
        data: readonly { readonly id: string; readonly name: string; readonly primary: boolean }[];
      }>(`/integrations/${calendarId}/calendars`, { workspace: workspaceId })
      .then((result) => {
        if (!alive) {
          return;
        }
        setCalendarOptions(result.data);
        if (
          calendarRef.trim() === '' ||
          !result.data.some((calendar) => calendar.id === calendarRef)
        ) {
          const preferred = result.data.find((calendar) => calendar.primary) ?? result.data[0];
          if (preferred !== undefined) {
            setCalendarRef(preferred.id);
          }
        }
      })
      .catch(() => {
        if (alive) {
          setCalendarOptions(null);
          setCalendarOptionsError(true);
        }
      })
      .finally(() => {
        if (alive) {
          setCalendarOptionsLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [calendarId, workspaceId]);
  const calendarValid =
    (calendarId === '') === (calendarRef.trim() === '') &&
    (calendarRef.trim() === '' || calendarRef.trim().length >= 3);
  const valid =
    locationId !== '' && name.trim() !== '' && slots >= 1 && slots <= 100 && calendarValid;

  const submit = () => {
    const seatCapacity = seats.trim() === '' ? undefined : Number(seats);
    if (resource === undefined) {
      return run(
        () =>
          api.post('/resources', {
            workspace: workspaceId,
            body: {
              location_id: locationId,
              name: name.trim(),
              resource_type: type,
              parallel_slots: slots,
              ...(seatCapacity === undefined ? {} : { seat_capacity: seatCapacity }),
              ...(calendarId === ''
                ? {}
                : {
                    calendar_integration_id: calendarId,
                    external_calendar_ref: calendarRef.trim(),
                  }),
            },
          }),
        t('created'),
      );
    }
    return run(
      () =>
        api.patch(`/resources/${resource.id}`, {
          workspace: workspaceId,
          ifMatch: resource.version,
          body: {
            name: name.trim(),
            parallel_slots: slots,
            ...(seatCapacity === undefined ? {} : { seat_capacity: seatCapacity }),
            calendar_integration_id: calendarId === '' ? null : calendarId,
            external_calendar_ref: calendarId === '' ? null : calendarRef.trim(),
            active,
          },
        }),
      t('saved'),
    );
  };

  return (
    <FormDialog
      trigger={
        resource === undefined ? (
          <Button disabled={locations.length === 0}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('create')}
          </Button>
        ) : (
          <Button variant="secondary" size="sm">
            <Pencil className="h-4 w-4" aria-hidden="true" />
            {t('edit')}
          </Button>
        )
      }
      title={resource === undefined ? t('create') : t('editTitle', { name: resource.name })}
      submitLabel={resource === undefined ? t('create') : t('save')}
      disabled={!valid}
      pending={pending}
      onSubmit={submit}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="resource-name" label={t('name')} required className="md:col-span-2">
          <Input
            id="resource-name"
            value={name}
            maxLength={160}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        {resource === undefined ? (
          <>
            <Field id="resource-location" label={t('location')} required>
              <NativeSelect
                id="resource-location"
                value={locationId}
                onChange={(event) => {
                  setLocationId(event.target.value);
                }}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="resource-type" label={t('type')} required>
              <NativeSelect
                id="resource-type"
                value={type}
                onChange={(event) => {
                  setType(event.target.value as ResourceKind);
                }}
              >
                {RESOURCE_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {te(value)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </>
        ) : null}
        <Field id="resource-slots" label={t('parallelSlots')} hint={t('parallelSlotsHint')}>
          <Input
            id="resource-slots"
            type="number"
            min={1}
            max={100}
            value={slots}
            onChange={(event) => {
              setSlots(Number(event.target.value));
            }}
          />
        </Field>
        <Field id="resource-seats" label={t('seatCapacity')}>
          <Input
            id="resource-seats"
            type="number"
            min={1}
            max={1000}
            value={seats}
            onChange={(event) => {
              setSeats(event.target.value);
            }}
          />
        </Field>
        <Field id="resource-calendar" label={t('calendar')}>
          <NativeSelect
            id="resource-calendar"
            value={calendarId}
            onChange={(event) => {
              setCalendarId(event.target.value);
            }}
          >
            <option value="">{t('noCalendar')}</option>
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {calendarId === '' ? null : (
          <Field
            id="resource-calendar-ref"
            label={t('calendarRef')}
            hint={calendarOptionsError ? t('calendarRefHint') : undefined}
            required
            error={calendarValid ? undefined : t('calendarRefInvalid')}
          >
            {calendarOptionsError ? (
              <Input
                id="resource-calendar-ref"
                value={calendarRef}
                maxLength={320}
                onChange={(event) => {
                  setCalendarRef(event.target.value);
                }}
              />
            ) : (
              <NativeSelect
                id="resource-calendar-ref"
                value={calendarRef}
                disabled={calendarOptionsLoading || calendarOptions === null}
                onChange={(event) => {
                  setCalendarRef(event.target.value);
                }}
              >
                {calendarOptionsLoading ? (
                  <option value="">{t('calendarRefLoading')}</option>
                ) : (
                  (calendarOptions ?? []).map((calendar) => (
                    <option key={calendar.id} value={calendar.id}>
                      {calendar.name}
                    </option>
                  ))
                )}
              </NativeSelect>
            )}
          </Field>
        )}
      </div>
      {resource === undefined ? null : (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={active}
            onCheckedChange={(value) => {
              setActive(value === true);
            }}
          />
          {t('active')}
        </label>
      )}
    </FormDialog>
  );
}

export function AvailabilityRulesEditor({
  workspaceId,
  resource,
  initial,
  timezone,
  timeZones,
  canWrite,
}: {
  readonly workspaceId: string;
  readonly resource: Resource;
  readonly initial: readonly AvailabilityRule[];
  readonly timezone: string;
  readonly timeZones: readonly string[];
  readonly canWrite: boolean;
}) {
  const t = useTranslations('bookings.availability');
  const tw = useTranslations('bookings.weekdays');
  const { pending, run } = useMutation();
  const [zone, setZone] = useState(initial[0]?.timezone ?? timezone);
  const [rules, setRules] = useState(
    initial.map((rule) => ({
      iso_weekday: rule.iso_weekday,
      start_local: rule.start_local,
      end_local: rule.end_local,
    })),
  );
  const valid = rules.every((rule) => rule.end_local > rule.start_local) && rules.length <= 42;
  const update = (index: number, patch: Partial<(typeof rules)[number]>) => {
    setRules((current) =>
      current.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)),
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <Field id="rules-timezone" label={t('timezone')}>
        <NativeSelect
          id="rules-timezone"
          value={zone}
          disabled={!canWrite}
          onChange={(event) => {
            setZone(event.target.value);
          }}
        >
          {timeZones.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {rules.length === 0 ? <p className="text-sm text-text-muted">{t('empty')}</p> : null}
      {rules.map((rule, index) => (
        <div key={String(index)} className="grid grid-cols-[1.4fr_1fr_1fr_auto] items-end gap-2">
          <Field id={`rule-day-${String(index)}`} label={t('day')}>
            <NativeSelect
              id={`rule-day-${String(index)}`}
              value={rule.iso_weekday}
              disabled={!canWrite}
              onChange={(event) => {
                update(index, { iso_weekday: Number(event.target.value) });
              }}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                <option key={day} value={day}>
                  {tw(String(day))}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            id={`rule-start-${String(index)}`}
            label={t('start')}
            error={rule.end_local > rule.start_local ? undefined : t('endAfterStart')}
          >
            <Input
              id={`rule-start-${String(index)}`}
              type="time"
              value={rule.start_local}
              disabled={!canWrite}
              onChange={(event) => {
                update(index, { start_local: event.target.value });
              }}
            />
          </Field>
          <Field id={`rule-end-${String(index)}`} label={t('end')}>
            <Input
              id={`rule-end-${String(index)}`}
              type="time"
              value={rule.end_local}
              disabled={!canWrite}
              onChange={(event) => {
                update(index, { end_local: event.target.value });
              }}
            />
          </Field>
          {canWrite ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                setRules((current) => current.filter((_, position) => position !== index));
              }}
              aria-label={t('remove')}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ))}
      {canWrite ? (
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={rules.length >= 42}
            onClick={() => {
              setRules((current) => [
                ...current,
                { iso_weekday: 1, start_local: '09:00', end_local: '17:00' },
              ]);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('add')}
          </Button>
          <Button
            type="button"
            loading={pending}
            disabled={pending || !valid}
            onClick={() =>
              void run(
                () =>
                  api.put(`/resources/${resource.id}/availability-rules`, {
                    workspace: workspaceId,
                    ifMatch: resource.version,
                    body: { timezone: zone, rules },
                  }),
                t('saved'),
              )
            }
          >
            {t('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ExceptionDialog({
  workspaceId,
  locationId,
  resourceId,
  timezone,
}: {
  readonly workspaceId: string;
  readonly locationId: string;
  readonly resourceId?: string;
  readonly timezone: string;
}) {
  const t = useTranslations('bookings.exceptions');
  const { pending, run } = useMutation();
  const [kind, setKind] = useState<'CLOSED' | 'EXTRA_OPENING'>('CLOSED');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');
  const valid = startsAt !== '' && endsAt !== '' && endsAt > startsAt;
  return (
    <FormDialog
      trigger={
        <Button variant="secondary" size="sm">
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('add')}
        </Button>
      }
      title={t('add')}
      submitLabel={t('add')}
      disabled={!valid}
      pending={pending}
      onSubmit={() =>
        run(
          () =>
            api.post('/availability-exceptions', {
              workspace: workspaceId,
              body: {
                location_id: locationId,
                ...(resourceId === undefined ? {} : { resource_id: resourceId }),
                exception_kind: kind,
                starts_at: zonedInstant(startsAt, timezone),
                ends_at: zonedInstant(endsAt, timezone),
                ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
              },
            }),
          t('created'),
        )
      }
    >
      <Field id="exception-kind" label={t('kind')}>
        <NativeSelect
          id="exception-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value === 'EXTRA_OPENING' ? 'EXTRA_OPENING' : 'CLOSED');
          }}
        >
          <option value="CLOSED">{t('kinds.CLOSED')}</option>
          <option value="EXTRA_OPENING">{t('kinds.EXTRA_OPENING')}</option>
        </NativeSelect>
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="exception-start" label={t('startsAt')} hint={timezone} required>
          <Input
            id="exception-start"
            type="datetime-local"
            value={startsAt}
            onChange={(event) => {
              setStartsAt(event.target.value);
            }}
          />
        </Field>
        <Field
          id="exception-end"
          label={t('endsAt')}
          required
          error={
            startsAt !== '' && endsAt !== '' && endsAt <= startsAt ? t('endAfterStart') : undefined
          }
        >
          <Input
            id="exception-end"
            type="datetime-local"
            value={endsAt}
            onChange={(event) => {
              setEndsAt(event.target.value);
            }}
          />
        </Field>
      </div>
      <Field id="exception-reason" label={t('reason')}>
        <Input
          id="exception-reason"
          value={reason}
          maxLength={300}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

export function DeleteExceptionButton({
  workspaceId,
  exception,
}: {
  readonly workspaceId: string;
  readonly exception: AvailabilityException;
}) {
  const t = useTranslations('bookings.exceptions');
  const { run } = useMutation();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="icon" aria-label={t('delete')}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </Button>
      }
      title={t('deleteTitle')}
      confirmLabel={t('delete')}
      destructive
      onConfirm={() =>
        run(
          () => api.delete(`/availability-exceptions/${exception.id}`, { workspace: workspaceId }),
          t('deleted'),
        )
      }
    />
  );
}

export function CancelBookingButton({
  workspaceId,
  booking,
}: {
  readonly workspaceId: string;
  readonly booking: Booking;
}) {
  const t = useTranslations('bookings.cancel');
  const { run } = useMutation();
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog
      trigger={
        <Button variant="secondary" size="sm">
          <XCircle className="h-4 w-4" aria-hidden="true" />
          {t('button')}
        </Button>
      }
      title={t('title', { reference: booking.reference })}
      description={t('description')}
      confirmLabel={t('confirm')}
      destructive
      confirmDisabled={reason.trim() === ''}
      onConfirm={() =>
        run(
          () =>
            api.post(`/bookings/${booking.id}/cancel`, {
              workspace: workspaceId,
              body: { reason: reason.trim() },
            }),
          t('done'),
        )
      }
    >
      <Field id={`cancel-reason-${booking.id}`} label={t('reason')} required>
        <Textarea
          id={`cancel-reason-${booking.id}`}
          value={reason}
          maxLength={300}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
    </ConfirmDialog>
  );
}
