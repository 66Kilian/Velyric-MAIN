'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PLAN_CATALOG, type PlanCode } from '@velyric/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Field,
  Input,
  NativeSelect,
  Spinner,
  Textarea,
  useToast,
  cn,
} from '@velyric/ui';
import { Check, CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { rememberWorkspace } from '@/components/shell/actions';
import { issueFor, useApiErrorToast, validationIssues } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import { ApiRequestError } from '@/lib/api-types';
import type { BillingProfile, CheckoutOrder, PendingInvitation } from '@/lib/api/billing';
import type {
  PhoneOrder,
  ProvisioningRequirement,
  ProvisioningStatus,
} from '@/lib/api/provisioning';
import { formatMinor } from '@/lib/format';
import type { WorkspaceDetail } from '@/lib/types';

const COUNTRIES = ['HU', 'AT', 'DE', 'CH', 'SK', 'RO', 'SI', 'HR', 'CZ', 'PL'] as const;
const COUNTRY_ZONES: Readonly<Record<string, string>> = {
  HU: 'Europe/Budapest',
  AT: 'Europe/Vienna',
  DE: 'Europe/Berlin',
  CH: 'Europe/Zurich',
  SK: 'Europe/Bratislava',
  RO: 'Europe/Bucharest',
  SI: 'Europe/Ljubljana',
  HR: 'Europe/Zagreb',
  CZ: 'Europe/Prague',
  PL: 'Europe/Warsaw',
};

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return slug.length >= 3 ? slug : `${slug}-ws`.replace(/^-/, 'w');
}

export function InvitationList({
  invitations,
}: {
  readonly invitations: readonly PendingInvitation[];
}) {
  const t = useTranslations('onboarding.invitations');
  const tr = useTranslations('enums.role');
  const router = useRouter();
  const showError = useApiErrorToast();
  const [pendingId, setPendingId] = useState<string | null>(null);
  if (invitations.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-5">
        <p className="font-semibold text-text">{t('title')}</p>
        <ul className="flex flex-col divide-y divide-border">
          {invitations.map((invitation) => (
            <li
              key={invitation.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <span className="flex flex-col">
                <span className="font-medium text-text">{invitation.workspace_name}</span>
                <span className="text-sm text-text-muted">
                  {tr.has(invitation.role) ? tr(invitation.role) : invitation.role}
                </span>
              </span>
              <Button
                size="sm"
                loading={pendingId === invitation.id}
                disabled={pendingId !== null}
                onClick={async () => {
                  setPendingId(invitation.id);
                  try {
                    await api.post(`/invitations/${invitation.tenant_id}/${invitation.id}/accept`);
                    await rememberWorkspace(invitation.tenant_id);
                    router.push(`/app/${invitation.tenant_id}/dashboard`);
                  } catch (error) {
                    showError(error);
                    setPendingId(null);
                  }
                }}
              >
                {t('accept')}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

const workspaceSchema = z.object({
  legal_name: z.string().trim().min(1, 'required').max(300, 'too_long'),
  display_name: z.string().trim().min(1, 'required').max(120, 'too_long'),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'slug'),
  country: z.enum(COUNTRIES),
  default_locale: z.enum(['hu', 'de', 'en']),
  timezone: z.string().min(3, 'required'),
  location_name: z.string().trim().min(1, 'required').max(160, 'too_long'),
});

type WorkspaceForm = z.infer<typeof workspaceSchema>;

export function CreateWorkspaceForm({ timeZones }: { readonly timeZones: readonly string[] }) {
  const t = useTranslations('onboarding.workspace');
  const tl = useTranslations('locations.form.countries');
  const locale = useLocale();
  const router = useRouter();
  const showError = useApiErrorToast();
  const [slugTouched, setSlugTouched] = useState(false);
  const { register, handleSubmit, formState, setValue, watch, setError } = useForm<WorkspaceForm>({
    resolver: zodResolver(workspaceSchema),
    mode: 'onBlur',
    defaultValues: {
      legal_name: '',
      display_name: '',
      slug: '',
      country: 'HU',
      default_locale: locale === 'de' || locale === 'en' ? locale : 'hu',
      timezone: 'Europe/Budapest',
      location_name: '',
    },
  });
  const country = watch('country');
  const message = (field: keyof WorkspaceForm) => {
    const code = formState.errors[field]?.message;
    return code === undefined
      ? undefined
      : t.has(`errors.${code}`)
        ? t(`errors.${code}`)
        : t('errors.invalid');
  };

  const submit = handleSubmit(async (values) => {
    try {
      const workspace = await api.post<WorkspaceDetail>('/workspaces', {
        body: {
          legal_name: values.legal_name,
          display_name: values.display_name,
          slug: values.slug,
          default_locale: values.default_locale,
          timezone: values.timezone,
          billing_market: values.country === 'HU' ? 'HU' : 'INTERNATIONAL',
          primary_location: {
            name: values.location_name,
            country: values.country,
            timezone: values.timezone,
          },
        },
      });
      await rememberWorkspace(workspace.id);
      router.push(`/app/onboarding?workspace=${workspace.id}&step=billing`);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'CONFLICT') {
        setError('slug', { type: 'server', message: 'slug_taken' });
      }
      for (const field of ['legal_name', 'display_name', 'slug', 'timezone'] as const) {
        if (issueFor(validationIssues(error), field) !== undefined) {
          setError(field, { type: 'server', message: 'invalid' });
        }
      }
      showError(error);
    }
  });

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="ws-display-name"
          label={t('displayName')}
          hint={t('displayNameHint')}
          required
          error={message('display_name')}
        >
          <Input
            id="ws-display-name"
            autoFocus
            {...register('display_name', {
              onChange: (event: { target: { value: string } }) => {
                if (!slugTouched) {
                  setValue('slug', slugify(event.target.value));
                }
              },
            })}
          />
        </Field>
        <Field
          id="ws-legal-name"
          label={t('legalName')}
          hint={t('legalNameHint')}
          required
          error={message('legal_name')}
        >
          <Input id="ws-legal-name" autoComplete="organization" {...register('legal_name')} />
        </Field>
        <Field id="ws-slug" label={t('slug')} hint={t('slugHint')} required error={message('slug')}>
          <Input
            id="ws-slug"
            spellCheck={false}
            {...register('slug', {
              onChange: () => {
                setSlugTouched(true);
              },
            })}
          />
        </Field>
        <Field id="ws-country" label={t('country')} required>
          <NativeSelect
            id="ws-country"
            {...register('country', {
              onChange: (event: { target: { value: string } }) => {
                const zone = COUNTRY_ZONES[event.target.value];
                if (zone !== undefined) {
                  setValue('timezone', zone);
                }
              },
            })}
          >
            {COUNTRIES.map((code) => (
              <option key={code} value={code}>
                {tl(code)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="ws-locale" label={t('language')}>
          <NativeSelect id="ws-locale" {...register('default_locale')}>
            <option value="hu">Magyar</option>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </NativeSelect>
        </Field>
        <Field id="ws-timezone" label={t('timezone')} error={message('timezone')}>
          <NativeSelect id="ws-timezone" {...register('timezone')}>
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          id="ws-location"
          label={t('locationName')}
          hint={t('locationNameHint')}
          required
          error={message('location_name')}
          className="md:col-span-2"
        >
          <Input id="ws-location" {...register('location_name')} />
        </Field>
      </div>
      {country !== 'HU' ? (
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-text-muted">
          {t('internationalNotice')}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" loading={formState.isSubmitting} disabled={formState.isSubmitting}>
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}

const profileSchema = z
  .object({
    customer_type: z.enum(['BUSINESS', 'INDIVIDUAL']),
    legal_name: z.string().trim().min(1, 'required').max(300, 'too_long'),
    country: z.string().regex(/^[A-Z]{2}$/, 'invalid'),
    postal_code: z.string().trim().min(2, 'required').max(16, 'too_long'),
    city: z.string().trim().min(1, 'required').max(120, 'too_long'),
    address_line1: z.string().trim().min(1, 'required').max(200, 'too_long'),
    address_line2: z.string().trim().max(200, 'too_long'),
    billing_email: z
      .string()
      .trim()
      .regex(/^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,63}$/, 'email'),
    hu_tax_number: z
      .string()
      .trim()
      .refine((value) => value === '' || /^[0-9]{8}-[1-5]-[0-9]{2}$/.test(value), 'hu_tax_number'),
    eu_vat_id: z
      .string()
      .trim()
      .refine((value) => value === '' || /^[A-Z]{2}[0-9A-Za-z+*.]{2,13}$/.test(value), 'eu_vat_id'),
  })
  .superRefine((value, context) => {
    if (
      value.customer_type === 'BUSINESS' &&
      value.country === 'HU' &&
      value.hu_tax_number === ''
    ) {
      context.addIssue({ code: 'custom', path: ['hu_tax_number'], message: 'hu_tax_required' });
    }
    if (
      value.eu_vat_id !== '' &&
      value.country !== 'GR' &&
      !value.eu_vat_id.startsWith(value.country)
    ) {
      context.addIssue({ code: 'custom', path: ['eu_vat_id'], message: 'vat_prefix' });
    }
  });

type ProfileForm = z.infer<typeof profileSchema>;

export function BillingProfileForm({
  workspaceId,
  profile,
  defaultCountry,
  defaultName,
  redirectTo,
}: {
  readonly workspaceId: string;
  readonly profile: BillingProfile | null;
  readonly defaultCountry: string;
  readonly defaultName: string;
  readonly redirectTo?: string;
}) {
  const t = useTranslations('onboarding.billing');
  const tl = useTranslations('locations.form.countries');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const { register, handleSubmit, formState, watch, setError } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    mode: 'onBlur',
    defaultValues: {
      customer_type: profile?.customer_type ?? 'BUSINESS',
      legal_name: profile?.legal_name ?? defaultName,
      country: profile?.country ?? defaultCountry,
      postal_code: profile?.postal_code ?? '',
      city: profile?.city ?? '',
      address_line1: profile?.address_line1 ?? '',
      address_line2: profile?.address_line2 ?? '',
      billing_email: profile?.billing_email ?? '',
      hu_tax_number: profile?.hu_tax_number ?? '',
      eu_vat_id: profile?.eu_vat_id ?? '',
    },
  });
  const customerType = watch('customer_type');
  const country = watch('country');
  const message = (field: keyof ProfileForm) => {
    const code = formState.errors[field]?.message;
    return code === undefined
      ? undefined
      : t.has(`errors.${code}`)
        ? t(`errors.${code}`)
        : t('errors.invalid');
  };
  const submit = handleSubmit(async (values) => {
    try {
      await api.put('/billing/profile', {
        workspace: workspaceId,
        ...(profile === null ? {} : { ifMatch: profile.version }),
        body: {
          customer_type: values.customer_type,
          legal_name: values.legal_name,
          country: values.country,
          postal_code: values.postal_code,
          city: values.city,
          address_line1: values.address_line1,
          billing_email: values.billing_email,
          ...(values.address_line2 === '' ? {} : { address_line2: values.address_line2 }),
          ...(values.hu_tax_number === '' ? {} : { hu_tax_number: values.hu_tax_number }),
          ...(values.eu_vat_id === '' ? {} : { eu_vat_id: values.eu_vat_id }),
        },
      });
      notify({ tone: 'success', title: t('saved') });
      if (redirectTo !== undefined) {
        router.push(redirectTo);
      }
      router.refresh();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'VAT_ID_INVALID') {
        setError('eu_vat_id', { type: 'server', message: 'eu_vat_id' });
      }
      if (error instanceof ApiRequestError && error.code === 'BILLING_PROFILE_INCOMPLETE') {
        setError('hu_tax_number', { type: 'server', message: 'hu_tax_required' });
      }
      showError(error);
    }
  });
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <fieldset className="flex gap-4">
        <legend className="sr-only">{t('customerType')}</legend>
        {(['BUSINESS', 'INDIVIDUAL'] as const).map((value) => (
          <label
            key={value}
            className={cn(
              'flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2.5 text-sm',
              customerType === value ? 'border-pink bg-pink-tint' : 'border-border',
            )}
          >
            <input
              type="radio"
              value={value}
              className="accent-[var(--pink)]"
              {...register('customer_type')}
            />
            {t(`customerTypes.${value}`)}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="bp-legal-name"
          label={customerType === 'BUSINESS' ? t('companyName') : t('fullName')}
          required
          error={message('legal_name')}
          className="md:col-span-2"
        >
          <Input
            id="bp-legal-name"
            autoComplete={customerType === 'BUSINESS' ? 'organization' : 'name'}
            {...register('legal_name')}
          />
        </Field>
        <Field id="bp-country" label={t('country')} required>
          <NativeSelect id="bp-country" {...register('country')}>
            {COUNTRIES.map((code) => (
              <option key={code} value={code}>
                {tl(code)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          id="bp-email"
          label={t('billingEmail')}
          hint={t('billingEmailHint')}
          required
          error={message('billing_email')}
        >
          <Input id="bp-email" type="email" autoComplete="email" {...register('billing_email')} />
        </Field>
        <Field id="bp-postal" label={t('postalCode')} required error={message('postal_code')}>
          <Input id="bp-postal" autoComplete="postal-code" {...register('postal_code')} />
        </Field>
        <Field id="bp-city" label={t('city')} required error={message('city')}>
          <Input id="bp-city" autoComplete="address-level2" {...register('city')} />
        </Field>
        <Field id="bp-line1" label={t('address')} required error={message('address_line1')}>
          <Input id="bp-line1" autoComplete="address-line1" {...register('address_line1')} />
        </Field>
        <Field id="bp-line2" label={t('address2')} error={message('address_line2')}>
          <Input id="bp-line2" autoComplete="address-line2" {...register('address_line2')} />
        </Field>
        {customerType === 'BUSINESS' && country === 'HU' ? (
          <Field
            id="bp-hu-tax"
            label={t('huTaxNumber')}
            hint="12345678-2-42"
            required
            error={message('hu_tax_number')}
          >
            <Input id="bp-hu-tax" inputMode="numeric" {...register('hu_tax_number')} />
          </Field>
        ) : null}
        {customerType === 'BUSINESS' ? (
          <Field
            id="bp-vat"
            label={t('euVatId')}
            hint={t('euVatIdHint')}
            error={message('eu_vat_id')}
          >
            <Input id="bp-vat" {...register('eu_vat_id')} />
          </Field>
        ) : null}
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={formState.isSubmitting} disabled={formState.isSubmitting}>
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}

export function PlanPicker({
  workspaceId,
  market,
  termsVersion,
  canceled,
  salesEmail,
}: {
  readonly workspaceId: string;
  readonly market: string;
  readonly termsVersion: string;
  readonly canceled: boolean;
  readonly salesEmail: string;
}) {
  const t = useTranslations('onboarding.plan');
  const locale = useLocale();
  const showError = useApiErrorToast();
  const [selected, setSelected] = useState<PlanCode>('BUSINESS');
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const plans = (['START', 'BUSINESS', 'PRO'] as const).map((code) => ({
    code,
    definition: PLAN_CATALOG[code],
    price: PLAN_CATALOG[code].prices.find((entry) => entry.market === market) ?? null,
  }));
  const available = plans.some((plan) => plan.price !== null);
  return (
    <div className="flex flex-col gap-5">
      {canceled ? (
        <p className="rounded-md border border-warning/50 bg-surface px-3 py-2 text-sm text-warning-text">
          {t('canceled')}
        </p>
      ) : null}
      {!available ? (
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-text-muted">
          {t('marketUnavailable')}
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3" role="radiogroup" aria-label={t('choose')}>
        {plans.map(({ code, definition, price }) => (
          <button
            key={code}
            type="button"
            role="radio"
            aria-checked={selected === code}
            disabled={price === null}
            onClick={() => {
              setSelected(code);
            }}
            className={cn(
              'flex flex-col gap-3 rounded-xl border bg-surface p-5 text-left shadow-soft transition-colors disabled:opacity-50',
              selected === code
                ? 'border-pink ring-2 ring-pink-tint-strong'
                : 'border-border hover:border-pink/40',
            )}
          >
            <span className="flex items-center justify-between">
              <span className="text-lg font-semibold text-text">{t(`plans.${code}.name`)}</span>
              {code === 'BUSINESS' ? <Badge tone="pink">{t('popular')}</Badge> : null}
            </span>
            <span className="text-sm text-text-muted">{t(`plans.${code}.tagline`)}</span>
            {price === null ? null : (
              <span className="flex items-baseline gap-1">
                <span className="text-2xl font-bold tabular-nums text-text">
                  {formatMinor(price.monthlyNetMinor, price.currency, locale)}
                </span>
                <span className="text-sm text-text-muted">{t('perMonth')}</span>
              </span>
            )}
            <ul className="flex flex-col gap-1.5 text-sm text-text">
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                {t('includedMinutes', {
                  minutes: Math.round((definition.includedVoiceSeconds ?? 0) / 60),
                })}
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                {t('concurrentCalls', { count: definition.concurrentCalls })}
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                {t('phoneNumbers', { count: definition.includedPhoneNumbers })}
              </li>
              {price === null ? null : (
                <li className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  {t('overage', {
                    price: formatMinor(price.overagePerMinuteNetMinor, price.currency, locale),
                  })}
                </li>
              )}
            </ul>
          </button>
        ))}
      </div>
      <p className="text-sm text-text-muted">
        {t('enterprise')}{' '}
        <a className="font-medium text-violet-text hover:underline" href={`mailto:${salesEmail}`}>
          {t('contactSales')}
        </a>
      </p>
      <label className="flex items-start gap-2 text-sm text-text">
        <Checkbox
          checked={accepted}
          onCheckedChange={(value) => {
            setAccepted(value === true);
          }}
          className="mt-0.5"
        />
        <span>
          {t.rich('terms', {
            terms: (chunks) => (
              <Link href="/legal/terms" target="_blank" className="text-violet-text underline">
                {chunks}
              </Link>
            ),
            privacy: (chunks) => (
              <Link href="/legal/privacy" target="_blank" className="text-violet-text underline">
                {chunks}
              </Link>
            ),
          })}
        </span>
      </label>
      <div className="flex justify-end">
        <Button
          loading={pending}
          disabled={pending || !accepted || !available}
          onClick={async () => {
            setPending(true);
            try {
              const result = await api.post<{ checkout_url: string }>('/billing/checkout', {
                workspace: workspaceId,
                body: {
                  plan_code: selected,
                  terms_version: termsVersion,
                  locale: locale === 'de' || locale === 'en' ? locale : 'hu',
                },
              });
              window.location.assign(result.checkout_url);
            } catch (error) {
              showError(error);
              setPending(false);
            }
          }}
        >
          {t('checkout')}
        </Button>
      </div>
    </div>
  );
}

const FINAL_ORDER_STATUSES = new Set([
  'PAID',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);

export function OrderStatusPoller({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string;
  readonly initial: CheckoutOrder;
}) {
  const t = useTranslations('checkout.return');
  const locale = useLocale();
  const [order, setOrder] = useState(initial);
  const [attempts, setAttempts] = useState(0);
  useEffect(() => {
    if (FINAL_ORDER_STATUSES.has(order.status) || attempts > 90) {
      return;
    }
    const timer = window.setTimeout(() => {
      void api
        .get<CheckoutOrder>(`/billing/orders/${order.id}`, { workspace: workspaceId })
        .then(setOrder, () => undefined)
        .finally(() => {
          setAttempts((value) => value + 1);
        });
    }, 2000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [attempts, order.id, order.status, workspaceId]);
  const paid = order.status === 'PAID';
  const failed = FINAL_ORDER_STATUSES.has(order.status) && !paid;
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        {paid ? (
          <CheckCircle2 className="h-12 w-12 text-success" aria-hidden="true" />
        ) : failed ? (
          <XCircle className="h-12 w-12 text-danger" aria-hidden="true" />
        ) : (
          <Spinner className="h-10 w-10" label={t('waiting')} />
        )}
        <h1 className="text-2xl font-bold text-text" aria-live="polite">
          {paid ? t('paidTitle') : failed ? t('failedTitle') : t('waitingTitle')}
        </h1>
        <p className="max-w-md text-sm text-text-muted">
          {paid
            ? t('paidBody')
            : failed
              ? t('failedBody')
              : attempts > 90
                ? t('slowBody')
                : t('waitingBody')}
        </p>
        <p className="text-sm tabular-nums text-text">
          {t('total', {
            amount: formatMinor(order.total.amount_minor, order.total.currency, locale),
            plan: order.plan_code,
          })}
        </p>
        {paid ? (
          <Link
            href={`/app/onboarding?workspace=${workspaceId}&step=provisioning`}
            className="vly-gradient-cta inline-flex h-10 items-center rounded-md px-5 text-sm font-semibold shadow-cta"
          >
            {t('continue')}
          </Link>
        ) : failed ? (
          <Link
            href={`/app/onboarding?workspace=${workspaceId}&step=plan`}
            className="inline-flex h-10 items-center rounded-md border border-border px-5 text-sm font-semibold text-text"
          >
            {t('retry')}
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

function requirementLabel(requirement: ProvisioningRequirement): string {
  const raw = requirement.label_key.split('.').pop() ?? requirement.label_key;
  const words = raw.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => {
      reject(new Error('file_read_failed'));
    };
    reader.readAsDataURL(file);
  });
}

interface AddressDraft {
  business_name: string;
  first_name: string;
  last_name: string;
  street_address: string;
  locality: string;
  postal_code: string;
  country_code: string;
}

function KycOrderForm({
  workspaceId,
  order,
  onSubmitted,
}: {
  readonly workspaceId: string;
  readonly order: PhoneOrder;
  readonly onSubmitted: () => void;
}) {
  const t = useTranslations('onboarding.kyc');
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const open = order.requirements.filter(
    (requirement) => requirement.status === 'REQUIRED' || requirement.status === 'DECLINED',
  );
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, File>>({});
  const [addresses, setAddresses] = useState<Record<string, AddressDraft>>({});
  const [pending, setPending] = useState(false);
  if (open.length === 0) {
    return null;
  }
  const emptyAddress: AddressDraft = {
    business_name: '',
    first_name: '',
    last_name: '',
    street_address: '',
    locality: '',
    postal_code: '',
    country_code: order.country,
  };
  const complete = open.every((requirement) => {
    if (requirement.field_type === 'TEXTUAL') return (texts[requirement.id] ?? '').trim() !== '';
    if (requirement.field_type === 'DOCUMENT') return files[requirement.id] !== undefined;
    if (requirement.field_type === 'ADDRESS') {
      const address = addresses[requirement.id];
      return (
        address !== undefined &&
        [
          address.business_name,
          address.first_name,
          address.last_name,
          address.street_address,
          address.locality,
          address.postal_code,
          address.country_code,
        ].every((value) => value.trim() !== '')
      );
    }
    return true;
  });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        try {
          const values = await Promise.all(
            open
              .filter((requirement) => requirement.field_type !== 'ACTION')
              .map(async (requirement) => {
                if (requirement.field_type === 'DOCUMENT') {
                  const file = files[requirement.id];
                  const safeName = (file?.name ?? 'document.pdf')
                    .replace(/[^A-Za-z0-9 ._-]/g, '_')
                    .replace(/^[^A-Za-z0-9]+/, '')
                    .slice(-120);
                  return {
                    kyc_requirement_id: requirement.id,
                    document: {
                      filename: safeName,
                      content_base64: file === undefined ? '' : await readBase64(file),
                    },
                  };
                }
                if (requirement.field_type === 'ADDRESS') {
                  return {
                    kyc_requirement_id: requirement.id,
                    address: addresses[requirement.id] ?? emptyAddress,
                  };
                }
                return {
                  kyc_requirement_id: requirement.id,
                  text: (texts[requirement.id] ?? '').trim(),
                };
              }),
          );
          await api.post(`/phone-orders/${order.id}/kyc-submissions`, {
            workspace: workspaceId,
            body: { values },
          });
          notify({ tone: 'success', title: t('submitted') });
          onSubmitted();
        } catch (error) {
          showError(error);
        } finally {
          setPending(false);
        }
      }}
    >
      {open.map((requirement) => (
        <div
          key={requirement.id}
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-text">{requirementLabel(requirement)}</p>
            {requirement.status === 'DECLINED' ? (
              <Badge tone="danger">{t('declined')}</Badge>
            ) : null}
          </div>
          {requirement.decline_reason === null ? null : (
            <p className="text-sm text-danger-text">{requirement.decline_reason}</p>
          )}
          {requirement.field_type === 'TEXTUAL' ? (
            <Textarea
              aria-label={requirementLabel(requirement)}
              rows={2}
              maxLength={2000}
              value={texts[requirement.id] ?? ''}
              onChange={(event) => {
                setTexts((current) => ({ ...current, [requirement.id]: event.target.value }));
              }}
            />
          ) : null}
          {requirement.field_type === 'DOCUMENT' ? (
            <Field id={`kyc-doc-${requirement.id}`} label={t('document')} hint={t('documentHint')}>
              <Input
                id={`kyc-doc-${requirement.id}`}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                className="py-2"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined && file.size <= 4 * 1024 * 1024) {
                    setFiles((current) => ({ ...current, [requirement.id]: file }));
                  } else if (file !== undefined) {
                    notify({ tone: 'error', title: t('documentTooLarge') });
                  }
                }}
              />
            </Field>
          ) : null}
          {requirement.field_type === 'ADDRESS' ? (
            <div className="grid gap-3 md:grid-cols-2">
              {(
                [
                  'business_name',
                  'first_name',
                  'last_name',
                  'street_address',
                  'postal_code',
                  'locality',
                ] as const
              ).map((key) => (
                <Field
                  key={key}
                  id={`kyc-${requirement.id}-${key}`}
                  label={t(`address.${key}`)}
                  required
                >
                  <Input
                    id={`kyc-${requirement.id}-${key}`}
                    value={(addresses[requirement.id] ?? emptyAddress)[key]}
                    onChange={(event) => {
                      setAddresses((current) => ({
                        ...current,
                        [requirement.id]: {
                          ...(current[requirement.id] ?? emptyAddress),
                          [key]: event.target.value,
                        },
                      }));
                    }}
                  />
                </Field>
              ))}
            </div>
          ) : null}
          {requirement.field_type === 'ACTION' ? (
            <p className="text-sm text-text-muted">{t('action')}</p>
          ) : null}
        </div>
      ))}
      <div className="flex justify-end">
        <Button type="submit" loading={pending} disabled={pending || !complete}>
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}

const DONE_STATES = new Set(['ACTIVE']);

export function ProvisioningPanel({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string;
  readonly initial: ProvisioningStatus;
}) {
  const t = useTranslations('onboarding.provisioning');
  const te = useTranslations('enums');
  const [status, setStatus] = useState(initial);
  const [tick, setTick] = useState(0);
  const state = status.workflow?.state ?? null;
  const done = state !== null && DONE_STATES.has(state);
  useEffect(() => {
    if (done) {
      return;
    }
    const timer = window.setTimeout(() => {
      void api
        .get<ProvisioningStatus>('/provisioning', { workspace: workspaceId })
        .then(setStatus, () => undefined)
        .finally(() => {
          setTick((value) => value + 1);
        });
    }, 4000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [done, tick, workspaceId]);
  const refresh = async () => {
    setStatus(await api.get<ProvisioningStatus>('/provisioning', { workspace: workspaceId }));
  };
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardContent className="flex flex-col gap-4 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-lg font-semibold text-text" aria-live="polite">
                {state === null
                  ? t('waitingForPayment')
                  : te.has(`provisioningState.${state}`)
                    ? te(`provisioningState.${state}`)
                    : state}
              </p>
              {status.workflow?.blocking_reason === null || status.workflow === null ? null : (
                <p className="text-sm text-warning-text">{status.workflow.blocking_reason}</p>
              )}
            </div>
            {done ? (
              <Link
                href={`/app/${workspaceId}/dashboard`}
                className="vly-gradient-cta inline-flex h-10 items-center rounded-md px-5 text-sm font-semibold shadow-cta"
              >
                {t('openDashboard')}
              </Link>
            ) : (
              <Loader2
                className="h-5 w-5 animate-spin text-pink motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
          </div>
          {status.steps.length === 0 ? null : (
            <ol className="flex flex-col gap-2">
              {status.steps.map((step) => (
                <li
                  key={`${step.step}-${String(step.attempt)}`}
                  className="flex items-center gap-2 text-sm"
                >
                  {step.status === 'SUCCEEDED' ? (
                    <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                  ) : step.status === 'FAILED' ? (
                    <XCircle className="h-4 w-4 text-danger" aria-hidden="true" />
                  ) : (
                    <Circle className="h-4 w-4 text-text-muted" aria-hidden="true" />
                  )}
                  <span className="text-text">
                    {t.has(`steps.${step.step}`) ? t(`steps.${step.step}`) : step.step}
                  </span>
                  {step.error_code === null ? null : (
                    <span className="font-mono text-xs text-danger-text">{step.error_code}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
      {done ? null : (
        <Card className="border-pink/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-5">
            <div className="min-w-0">
              <p className="font-semibold text-text">{t('setupTitle')}</p>
              <p className="mt-1 text-sm text-text-muted">{t('setupBody')}</p>
            </div>
            <Link
              href={`/app/setup/${workspaceId}`}
              className="vly-gradient-cta inline-flex h-10 items-center rounded-md px-5 text-sm font-semibold shadow-cta"
            >
              {t('setupAction')}
            </Link>
          </CardContent>
        </Card>
      )}
      {status.phone_orders.map((order) => (
        <Card key={order.id}>
          <CardContent className="flex flex-col gap-4 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-text">
                {t('phoneOrder', {
                  number: order.e164 ?? t('numberPending'),
                  country: order.country,
                })}
              </p>
              <Badge tone="sky">
                {te.has(`phoneOrderStatus.${order.status}`)
                  ? te(`phoneOrderStatus.${order.status}`)
                  : order.status}
              </Badge>
            </div>
            <KycOrderForm
              workspaceId={workspaceId}
              order={order}
              onSubmitted={() => void refresh()}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
