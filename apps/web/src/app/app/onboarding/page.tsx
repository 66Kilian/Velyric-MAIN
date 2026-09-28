import { Card, CardContent, cn } from '@velyric/ui';
import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import {
  BillingProfileForm,
  CreateWorkspaceForm,
  InvitationList,
  PlanPicker,
  ProvisioningPanel,
} from '@/components/onboarding/onboarding-forms';
import type { BillingProfile, PendingInvitation } from '@/lib/api/billing';
import type { ProvisioningStatus } from '@/lib/api/provisioning';
import type { WorkspaceDetail } from '@/lib/types';
import { serverGet, serverGetOrNull } from '@/server/api';
import { webConfig } from '@/server/config';
import { getMe } from '@/server/session';
import { searchValue } from '@/server/workspace';

const STEPS = ['workspace', 'billing', 'plan', 'provisioning'] as const;
type Step = (typeof STEPS)[number];

export default async function OnboardingPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const me = await getMe();
  const t = await getTranslations('onboarding');
  const workspaceId = searchValue(search['workspace']);
  const requested = searchValue(search['step']);
  const membership =
    workspaceId === undefined
      ? undefined
      : me.workspaces.find((workspace) => workspace.id === workspaceId);
  if (workspaceId !== undefined && membership === undefined) {
    notFound();
  }
  const step: Step =
    membership === undefined
      ? 'workspace'
      : requested === 'plan' || requested === 'provisioning'
        ? requested
        : 'billing';
  if (membership !== undefined && membership.status === 'ACTIVE' && step !== 'provisioning') {
    redirect(`/app/${membership.id}/dashboard`);
  }

  const [invitations, workspace, profile, provisioning] = await Promise.all([
    step === 'workspace'
      ? serverGet<{ data: PendingInvitation[] }>('/invitations')
      : Promise.resolve(null),
    membership === undefined
      ? Promise.resolve(null)
      : serverGet<WorkspaceDetail>(`/workspaces/${membership.id}`, { workspace: membership.id }),
    membership === undefined || step === 'provisioning'
      ? Promise.resolve(null)
      : serverGetOrNull<BillingProfile>('/billing/profile', { workspace: membership.id }),
    membership !== undefined && step === 'provisioning'
      ? serverGet<ProvisioningStatus>('/provisioning', { workspace: membership.id })
      : Promise.resolve(null),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-wrap gap-2" aria-label={t('progress')}>
        {STEPS.map((entry, index) => {
          const current = entry === step;
          const complete = STEPS.indexOf(step) > index;
          return (
            <li
              key={entry}
              aria-current={current ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm',
                current
                  ? 'bg-pink-tint-strong font-semibold text-pink-text'
                  : complete
                    ? 'bg-surface text-text'
                    : 'bg-surface text-text-muted',
              )}
            >
              <span className="tabular-nums">{index + 1}.</span>
              {t(`steps.${entry}`)}
            </li>
          );
        })}
      </ol>
      <div>
        <h1 className="text-[28px] font-bold tracking-[-0.02em] text-text">
          {t(`headings.${step}.title`)}
        </h1>
        <p className="mt-1 text-[15px] text-text-muted">{t(`headings.${step}.description`)}</p>
      </div>
      {step === 'workspace' ? (
        <>
          <InvitationList invitations={invitations?.data ?? []} />
          <Card>
            <CardContent className="pt-5">
              <CreateWorkspaceForm timeZones={Intl.supportedValuesOf('timeZone')} />
            </CardContent>
          </Card>
        </>
      ) : null}
      {step === 'billing' && workspace !== null ? (
        <Card>
          <CardContent className="pt-5">
            <BillingProfileForm
              workspaceId={workspace.id}
              profile={profile}
              defaultCountry={workspace.billing_market === 'HU' ? 'HU' : 'DE'}
              defaultName={workspace.legal_name}
              redirectTo={`/app/onboarding?workspace=${workspace.id}&step=plan`}
            />
          </CardContent>
        </Card>
      ) : null}
      {step === 'plan' && workspace !== null ? (
        profile === null ? (
          <p className="rounded-md border border-warning/50 bg-surface px-4 py-3 text-sm text-warning-text">
            {t('profileRequired')}
          </p>
        ) : (
          <PlanPicker
            workspaceId={workspace.id}
            market={profile.billing_market}
            termsVersion={webConfig().termsVersion}
            salesEmail={webConfig().legalEntity.salesEmail}
            canceled={searchValue(search['checkout']) === 'canceled'}
          />
        )
      ) : null}
      {step === 'provisioning' && workspace !== null && provisioning !== null ? (
        <ProvisioningPanel workspaceId={workspace.id} initial={provisioning} />
      ) : null}
    </div>
  );
}
