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
  useToast,
} from '@velyric/ui';
import { Plus, Star, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { BusinessHoursEntry, Holiday, Location } from '@/lib/api/scheduling';

const COUNTRIES = ['HU', 'AT', 'DE', 'CH', 'SK', 'RO', 'SI', 'HR', 'CZ', 'PL'] as const;

interface Draft {
  name: string;
  timezone: string;
  country: string;
  line1: string;
  line2: string;
  city: string;
  postalCode: string;
  region: string;
  hours: BusinessHoursEntry[];
  holidays: Holiday[];
}

function draftOf(location: Location | undefined, timezone: string): Draft {
  return {
    name: location?.name ?? '',
    timezone: location?.timezone ?? timezone,
    country: location?.country ?? 'HU',
    line1: location?.address?.line1 ?? '',
    line2: location?.address?.line2 ?? '',
    city: location?.address?.city ?? '',
    postalCode: location?.address?.postal_code ?? '',
    region: location?.address?.region ?? '',
    hours: [
      ...(location?.business_hours ??
        [1, 2, 3, 4, 5].map((day) => ({ iso_weekday: day, opens: '08:00', closes: '17:00' }))),
    ],
    holidays: [...(location?.holiday_calendar ?? [])],
  };
}

function overlaps(hours: readonly BusinessHoursEntry[]): boolean {
  return hours.some(
    (entry, index) =>
      entry.closes <= entry.opens ||
      hours.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.iso_weekday === entry.iso_weekday &&
          other.opens < entry.closes &&
          entry.opens < other.closes,
      ),
  );
}

function body(draft: Draft, includeCountry: boolean): Record<string, unknown> {
  const addressComplete =
    draft.line1.trim() !== '' && draft.city.trim() !== '' && draft.postalCode.trim().length >= 2;
  return {
    name: draft.name.trim(),
    timezone: draft.timezone,
    ...(includeCountry ? { country: draft.country } : {}),
    ...(addressComplete
      ? {
          address: {
            line1: draft.line1.trim(),
            city: draft.city.trim(),
            postal_code: draft.postalCode.trim(),
            ...(draft.line2.trim() === '' ? {} : { line2: draft.line2.trim() }),
            ...(draft.region.trim() === '' ? {} : { region: draft.region.trim() }),
          },
        }
      : {}),
    business_hours: draft.hours,
    holiday_calendar: draft.holidays.filter(
      (holiday) => holiday.name.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(holiday.date),
    ),
  };
}

export function LocationForm({
  workspaceId,
  location,
  timezone,
  timeZones,
  canManage,
  onSaved,
}: {
  readonly workspaceId: string;
  readonly location?: Location;
  readonly timezone: string;
  readonly timeZones: readonly string[];
  readonly canManage: boolean;
  readonly onSaved?: (location: Location) => void;
}) {
  const t = useTranslations('locations.form');
  const tw = useTranslations('bookings.weekdays');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [draft, setDraft] = useState<Draft>(() => draftOf(location, timezone));
  const [pending, setPending] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const hoursInvalid = overlaps(draft.hours);
  const valid = draft.name.trim() !== '' && !hoursInvalid;
  const disabled = !canManage;

  const save = async () => {
    setPending(true);
    try {
      const saved =
        location === undefined
          ? await api.post<Location>('/locations', {
              workspace: workspaceId,
              body: body(draft, true),
            })
          : await api.patch<Location>(`/locations/${location.id}`, {
              workspace: workspaceId,
              ifMatch: location.version,
              body: body(draft, false),
            });
      notify({ tone: 'success', title: location === undefined ? t('created') : t('saved') });
      onSaved?.(saved);
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="location-name" label={t('name')} required>
          <Input
            id="location-name"
            value={draft.name}
            maxLength={160}
            disabled={disabled}
            onChange={(event) => {
              set('name', event.target.value);
            }}
          />
        </Field>
        <Field id="location-timezone" label={t('timezone')}>
          <NativeSelect
            id="location-timezone"
            value={draft.timezone}
            disabled={disabled}
            onChange={(event) => {
              set('timezone', event.target.value);
            }}
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {location === undefined ? (
          <Field id="location-country" label={t('country')}>
            <NativeSelect
              id="location-country"
              value={draft.country}
              onChange={(event) => {
                set('country', event.target.value);
              }}
            >
              {COUNTRIES.map((country) => (
                <option key={country} value={country}>
                  {t(`countries.${country}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        <Field id="location-line1" label={t('line1')}>
          <Input
            id="location-line1"
            value={draft.line1}
            maxLength={200}
            disabled={disabled}
            autoComplete="address-line1"
            onChange={(event) => {
              set('line1', event.target.value);
            }}
          />
        </Field>
        <Field id="location-line2" label={t('line2')}>
          <Input
            id="location-line2"
            value={draft.line2}
            maxLength={200}
            disabled={disabled}
            autoComplete="address-line2"
            onChange={(event) => {
              set('line2', event.target.value);
            }}
          />
        </Field>
        <Field id="location-postal" label={t('postalCode')}>
          <Input
            id="location-postal"
            value={draft.postalCode}
            maxLength={16}
            disabled={disabled}
            autoComplete="postal-code"
            onChange={(event) => {
              set('postalCode', event.target.value);
            }}
          />
        </Field>
        <Field id="location-city" label={t('city')}>
          <Input
            id="location-city"
            value={draft.city}
            maxLength={100}
            disabled={disabled}
            autoComplete="address-level2"
            onChange={(event) => {
              set('city', event.target.value);
            }}
          />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-text">{t('hours')}</legend>
        {draft.hours.map((entry, index) => (
          <div key={String(index)} className="grid grid-cols-[1.4fr_1fr_1fr_auto] items-end gap-2">
            <Field id={`hours-day-${String(index)}`} label={t('day')}>
              <NativeSelect
                id={`hours-day-${String(index)}`}
                value={entry.iso_weekday}
                disabled={disabled}
                onChange={(event) => {
                  set(
                    'hours',
                    draft.hours.map((row, position) =>
                      position === index
                        ? { ...row, iso_weekday: Number(event.target.value) }
                        : row,
                    ),
                  );
                }}
              >
                {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                  <option key={day} value={day}>
                    {tw(String(day))}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id={`hours-opens-${String(index)}`} label={t('opens')}>
              <Input
                id={`hours-opens-${String(index)}`}
                type="time"
                value={entry.opens}
                disabled={disabled}
                onChange={(event) => {
                  set(
                    'hours',
                    draft.hours.map((row, position) =>
                      position === index ? { ...row, opens: event.target.value } : row,
                    ),
                  );
                }}
              />
            </Field>
            <Field id={`hours-closes-${String(index)}`} label={t('closes')}>
              <Input
                id={`hours-closes-${String(index)}`}
                type="time"
                value={entry.closes}
                disabled={disabled}
                onChange={(event) => {
                  set(
                    'hours',
                    draft.hours.map((row, position) =>
                      position === index ? { ...row, closes: event.target.value } : row,
                    ),
                  );
                }}
              />
            </Field>
            {canManage ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => {
                  set(
                    'hours',
                    draft.hours.filter((_, position) => position !== index),
                  );
                }}
                aria-label={t('removeHours')}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        ))}
        {hoursInvalid ? <p className="text-sm text-danger-text">{t('hoursInvalid')}</p> : null}
        {canManage ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            disabled={draft.hours.length >= 21}
            onClick={() => {
              set('hours', [...draft.hours, { iso_weekday: 6, opens: '09:00', closes: '13:00' }]);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('addHours')}
          </Button>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-text">{t('holidays')}</legend>
        {draft.holidays.length === 0 ? (
          <p className="text-sm text-text-muted">{t('noHolidays')}</p>
        ) : null}
        {draft.holidays.map((holiday, index) => (
          <div key={String(index)} className="grid grid-cols-[1fr_2fr_auto_auto] items-end gap-2">
            <Field id={`holiday-date-${String(index)}`} label={t('date')}>
              <Input
                id={`holiday-date-${String(index)}`}
                type="date"
                value={holiday.date}
                disabled={disabled}
                onChange={(event) => {
                  set(
                    'holidays',
                    draft.holidays.map((row, position) =>
                      position === index ? { ...row, date: event.target.value } : row,
                    ),
                  );
                }}
              />
            </Field>
            <Field id={`holiday-name-${String(index)}`} label={t('holidayName')}>
              <Input
                id={`holiday-name-${String(index)}`}
                value={holiday.name}
                maxLength={100}
                disabled={disabled}
                onChange={(event) => {
                  set(
                    'holidays',
                    draft.holidays.map((row, position) =>
                      position === index ? { ...row, name: event.target.value } : row,
                    ),
                  );
                }}
              />
            </Field>
            <label className="flex h-10 items-center gap-2 text-sm">
              <Checkbox
                checked={holiday.closed}
                disabled={disabled}
                onCheckedChange={(value) => {
                  set(
                    'holidays',
                    draft.holidays.map((row, position) =>
                      position === index ? { ...row, closed: value === true } : row,
                    ),
                  );
                }}
              />
              {t('closed')}
            </label>
            {canManage ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => {
                  set(
                    'holidays',
                    draft.holidays.filter((_, position) => position !== index),
                  );
                }}
                aria-label={t('removeHoliday')}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        ))}
        {canManage ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            disabled={draft.holidays.length >= 100}
            onClick={() => {
              set('holidays', [...draft.holidays, { date: '', name: '', closed: true }]);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('addHoliday')}
          </Button>
        ) : null}
      </fieldset>

      {canManage ? (
        <div className="flex justify-end">
          <Button type="submit" loading={pending} disabled={pending || !valid}>
            {location === undefined ? t('create') : t('save')}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

export function CreateLocationDialog({
  workspaceId,
  timezone,
  timeZones,
}: {
  readonly workspaceId: string;
  readonly timezone: string;
  readonly timeZones: readonly string[];
}) {
  const t = useTranslations('locations');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('create')}
        </Button>
      </DialogTrigger>
      <DialogContent title={t('create')} closeLabel={tc('close')} size="lg">
        <LocationForm
          workspaceId={workspaceId}
          timezone={timezone}
          timeZones={timeZones}
          canManage
          onSaved={(location) => {
            setOpen(false);
            router.push(`/app/${workspaceId}/locations/${location.id}`);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function LocationStatusActions({
  workspaceId,
  location,
}: {
  readonly workspaceId: string;
  readonly location: Location;
}) {
  const t = useTranslations('locations.actions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      notify({ tone: 'success', title: success });
      router.refresh();
      return true;
    } catch (error) {
      showError(error);
      return false;
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {!location.is_primary && location.status === 'ACTIVE' ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void run(
              () => api.post(`/locations/${location.id}/make-primary`, { workspace: workspaceId }),
              t('primarySet'),
            )
          }
        >
          <Star className="h-4 w-4" aria-hidden="true" />
          {t('makePrimary')}
        </Button>
      ) : null}
      {location.is_primary ? null : location.status === 'ACTIVE' ? (
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm">
              {t('deactivate')}
            </Button>
          }
          title={t('deactivateTitle')}
          description={t('deactivateDescription')}
          confirmLabel={t('deactivate')}
          destructive
          onConfirm={() =>
            run(
              () =>
                api.patch(`/locations/${location.id}`, {
                  workspace: workspaceId,
                  ifMatch: location.version,
                  body: { status: 'INACTIVE' },
                }),
              t('deactivated'),
            )
          }
        />
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void run(
              () =>
                api.patch(`/locations/${location.id}`, {
                  workspace: workspaceId,
                  ifMatch: location.version,
                  body: { status: 'ACTIVE' },
                }),
              t('activated'),
            )
          }
        >
          {t('activate')}
        </Button>
      )}
    </div>
  );
}
