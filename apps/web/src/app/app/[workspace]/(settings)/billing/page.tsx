import { PLAN_CATALOG, type PlanCode } from '@velyric/contracts';
import {
  type BadgeTone,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DescriptionList,
  EmptyState,
  PageHeader,
  ProgressBar,
} from '@velyric/ui';
import { CreditCard } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { BillingProfileForm } from '@/components/onboarding/onboarding-forms';
import type { BillingProfile, SubscriptionOverview } from '@/lib/api/billing';
import { formatMinor } from '@/lib/format';
import { serverGet, serverGetOrNull } from '@/server/api';
import { requirePermission } from '@/server/session';
import { getWorkspaceDetail } from '@/server/workspace';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('navigation.app');
  return { title: t('billing') };
}

const STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  ACTIVE: 'success',
  TRIALING: 'sky',
  PAST_DUE: 'warning',
  UNPAID: 'danger',
  INCOMPLETE: 'warning',
  INCOMPLETE_EXPIRED: 'neutral',
  PAUSED: 'neutral',
  CANCELED: 'neutral',
};

function isPlan(value: string): value is PlanCode {
  return value in PLAN_CATALOG;
}

export default async function BillingPage({
  params,
}: {
  readonly params: Promise<{ workspace: string }>;
}) {
  const { workspace: workspaceId } = await params;
  const { permissions } = await requirePermission(workspaceId, 'billing:read');
  const [t, te, format, locale, workspace, overview, profile] = await Promise.all([
    getTranslations('billing'),
    getTranslations('enums'),
    getFormatter(),
    getLocale(),
    getWorkspaceDetail(workspaceId),
    serverGet<SubscriptionOverview>('/billing/subscription', { workspace: workspaceId }),
    serverGetOrNull<BillingProfile>('/billing/profile', { workspace: workspaceId }),
  ]);
  const subscription = overview.subscription;
  const entitlement = overview.entitlement;
  const date = (value: string | null) =>
    value === null
      ? '–'
      : format.dateTime(new Date(value), { dateStyle: 'long', timeZone: workspace.timezone });
  const usedSeconds = overview.usage
    .filter((entry) => entry.metric === 'billable_voice_seconds')
    .reduce((sum, entry) => sum + entry.quantity, 0);
  const includedSeconds = entitlement?.included_voice_seconds ?? 0;
  const plan =
    subscription !== null && isPlan(subscription.plan_code)
      ? PLAN_CATALOG[subscription.plan_code]
      : null;
  const price = plan?.prices.find((entry) => entry.market === workspace.billing_market) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      {subscription === null ? (
        <Card>
          <EmptyState
            icon={<CreditCard className="h-5 w-5" aria-hidden="true" />}
            title={t('noSubscription')}
            description={t('noSubscriptionDescription')}
            action={
              permissions.has('billing:manage') ? (
                <Link
                  href={`/app/onboarding?workspace=${workspaceId}&step=plan`}
                  className="vly-gradient-cta inline-flex h-10 items-center rounded-md px-5 text-sm font-semibold shadow-cta"
                >
                  {t('choosePlan')}
                </Link>
              ) : undefined
            }
            className="m-4 border-none"
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('subscription')}</CardTitle>
              <Badge tone={STATUS_TONES[subscription.status] ?? 'neutral'}>
                {te.has(`subscriptionStatus.${subscription.status}`)
                  ? te(`subscriptionStatus.${subscription.status}`)
                  : subscription.status}
              </Badge>
            </CardHeader>
            <CardContent>
              <DescriptionList
                items={[
                  {
                    term: t('plan'),
                    description: te.has(`planCode.${subscription.plan_code}`)
                      ? te(`planCode.${subscription.plan_code}`)
                      : subscription.plan_code,
                  },
                  {
                    term: t('price'),
                    description:
                      price === null
                        ? t('contractPrice')
                        : t('monthly', {
                            amount: formatMinor(price.monthlyNetMinor, price.currency, locale),
                          }),
                  },
                  { term: t('periodStart'), description: date(subscription.current_period_start) },
                  { term: t('periodEnd'), description: date(subscription.current_period_end) },
                  {
                    term: t('renewal'),
                    description: subscription.cancel_at_period_end
                      ? t('endsAtPeriodEnd')
                      : t('renewsAutomatically'),
                  },
                  ...(subscription.pending_plan_code === null
                    ? []
                    : [
                        {
                          term: t('pendingPlan'),
                          description: te.has(`planCode.${subscription.pending_plan_code}`)
                            ? te(`planCode.${subscription.pending_plan_code}`)
                            : subscription.pending_plan_code,
                        },
                      ]),
                ]}
              />
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{t('usage')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {entitlement === null ? (
                <p className="text-sm text-text-muted">{t('noEntitlement')}</p>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-text">{t('voiceMinutes')}</span>
                      <span className="tabular-nums text-text-muted">
                        {t('minutesOf', {
                          used: format.number(Math.round(usedSeconds / 60)),
                          included: format.number(Math.round(includedSeconds / 60)),
                        })}
                      </span>
                    </div>
                    <ProgressBar
                      value={usedSeconds}
                      max={Math.max(1, includedSeconds)}
                      label={t('voiceMinutes')}
                      tone={usedSeconds > includedSeconds ? 'warning' : 'pink'}
                    />
                    {usedSeconds > includedSeconds ? (
                      <p className="text-sm text-warning-text">
                        {t('overageActive', {
                          price: formatMinor(
                            entitlement.overage_per_minute.amount_minor,
                            entitlement.overage_per_minute.currency,
                            locale,
                          ),
                        })}
                      </p>
                    ) : null}
                  </div>
                  <DescriptionList
                    items={[
                      {
                        term: t('concurrency'),
                        description: format.number(entitlement.concurrency_limit),
                      },
                      {
                        term: t('billingPeriod'),
                        description: `${date(entitlement.billing_period_start)} – ${date(entitlement.billing_period_end)}`,
                      },
                      {
                        term: t('overagePrice'),
                        description: formatMinor(
                          entitlement.overage_per_minute.amount_minor,
                          entitlement.overage_per_minute.currency,
                          locale,
                        ),
                      },
                      {
                        term: t('features'),
                        description: t('featureCount', { count: entitlement.features.length }),
                      },
                    ]}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('profile')}</CardTitle>
        </CardHeader>
        <CardContent>
          {permissions.has('billing:manage') ? (
            <BillingProfileForm
              key={profile?.version ?? 0}
              workspaceId={workspaceId}
              profile={profile}
              defaultCountry={workspace.billing_market === 'HU' ? 'HU' : 'DE'}
              defaultName={workspace.legal_name}
            />
          ) : profile === null ? (
            <p className="text-sm text-text-muted">{t('noProfile')}</p>
          ) : (
            <DescriptionList
              items={[
                { term: t('legalName'), description: profile.legal_name },
                {
                  term: t('address'),
                  description: `${profile.postal_code} ${profile.city}, ${profile.address_line1}`,
                },
                { term: t('billingEmail'), description: profile.billing_email },
                {
                  term: t('taxNumber'),
                  description: profile.hu_tax_number ?? profile.eu_vat_id ?? '–',
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
