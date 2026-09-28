import type { TenantStatus } from '@velyric/contracts';

export type TenantLifecycleEvent =
  | 'CHECKOUT_PAID'
  | 'PROVISIONING_COMPLETED'
  | 'RENEWAL_PAYMENT_FAILED'
  | 'GRACE_EXPIRED'
  | 'RESTRICTION_EXPIRED'
  | 'INVOICE_PAID'
  | 'DISPUTE_OPENED'
  | 'DISPUTE_WON'
  | 'SUBSCRIPTION_CANCELED'
  | 'CANCEL_GRACE_EXPIRED'
  | 'RETENTION_EXPIRED'
  | 'DELETION_COMPLETED'
  | 'RISK_BLOCKED'
  | 'RISK_CLEARED'
  | 'ADMIN_SUSPENDED'
  | 'ADMIN_RELEASED';

export class TenantTransitionError extends Error {
  readonly from: TenantStatus;
  readonly event: TenantLifecycleEvent;

  constructor(from: TenantStatus, event: TenantLifecycleEvent) {
    super(`tenant status ${from} does not accept ${event}`);
    this.name = 'TenantTransitionError';
    this.from = from;
    this.event = event;
  }
}

const SERVICEABLE: readonly TenantStatus[] = [
  'ACTIVE',
  'PAYMENT_AT_RISK',
  'GRACE_PERIOD',
  'RESTRICTED',
];
const BILLING_SUSPENDED: readonly TenantStatus[] = [
  'PAYMENT_AT_RISK',
  'GRACE_PERIOD',
  'RESTRICTED',
  'SUSPENDED_BILLING',
  'CANCELED_GRACE',
];

type Rule = (from: TenantStatus) => TenantStatus | null;

const RULES: Readonly<Record<TenantLifecycleEvent, Rule>> = {
  CHECKOUT_PAID: (from) => (from === 'PROVISIONING' ? 'PROVISIONING' : null),
  PROVISIONING_COMPLETED: (from) => (from === 'PROVISIONING' ? 'ACTIVE' : null),
  RENEWAL_PAYMENT_FAILED: (from) =>
    from === 'ACTIVE' || from === 'PAYMENT_AT_RISK'
      ? 'GRACE_PERIOD'
      : from === 'GRACE_PERIOD' || from === 'RESTRICTED'
        ? from
        : null,
  GRACE_EXPIRED: (from) => (from === 'GRACE_PERIOD' ? 'SUSPENDED_BILLING' : null),
  RESTRICTION_EXPIRED: (from) => (from === 'RESTRICTED' ? 'SUSPENDED_BILLING' : null),
  INVOICE_PAID: (from) =>
    BILLING_SUSPENDED.includes(from)
      ? 'ACTIVE'
      : from === 'ACTIVE' || from === 'PROVISIONING'
        ? from
        : null,
  DISPUTE_OPENED: (from) =>
    from === 'DELETED' || from === 'DELETION' ? null : 'SUSPENDED_DISPUTE',
  DISPUTE_WON: (from) => (from === 'SUSPENDED_DISPUTE' ? 'ACTIVE' : null),
  SUBSCRIPTION_CANCELED: (from) =>
    SERVICEABLE.includes(from) || from === 'SUSPENDED_BILLING' || from === 'PROVISIONING'
      ? 'CANCELED_GRACE'
      : null,
  CANCEL_GRACE_EXPIRED: (from) => (from === 'CANCELED_GRACE' ? 'DATA_RETENTION' : null),
  RETENTION_EXPIRED: (from) => (from === 'DATA_RETENTION' ? 'DELETION' : null),
  DELETION_COMPLETED: (from) => (from === 'DELETION' ? 'DELETED' : null),
  RISK_BLOCKED: (from) =>
    from === 'DELETED' || from === 'DELETION' || from === 'SUSPENDED_DISPUTE'
      ? null
      : 'SUSPENDED_RISK',
  RISK_CLEARED: (from) => (from === 'SUSPENDED_RISK' ? 'ACTIVE' : null),
  ADMIN_SUSPENDED: (from) => (from === 'DELETED' || from === 'DELETION' ? null : 'SUSPENDED_ADMIN'),
  ADMIN_RELEASED: (from) => (from === 'SUSPENDED_ADMIN' ? 'ACTIVE' : null),
};

export function nextTenantStatus(from: TenantStatus, event: TenantLifecycleEvent): TenantStatus {
  const next = RULES[event](from);
  if (next === null) {
    throw new TenantTransitionError(from, event);
  }
  return next;
}

export function tenantAcceptsCalls(status: TenantStatus): boolean {
  return status === 'ACTIVE' || status === 'PAYMENT_AT_RISK' || status === 'GRACE_PERIOD';
}

export function tenantRetainsConfiguration(status: TenantStatus): boolean {
  return status !== 'DELETED';
}

export const DUNNING_SCHEDULE_DAYS = Object.freeze({
  reminders: [-5, -3, -1] as const,
  renewalAttempt: 0,
  graceReminder: 1,
  finalGraceDay: 2,
});

export interface DunningStep {
  readonly offsetDays: number;
  readonly notification:
    | 'RENEWAL_REMINDER_5D'
    | 'RENEWAL_REMINDER_3D'
    | 'RENEWAL_REMINDER_1D'
    | 'GRACE_PERIOD_REMINDER'
    | 'GRACE_PERIOD_FINAL_DAY';
  readonly at: Date;
}

const DAY_MS = 86_400_000;

export function renewalReminderSteps(periodEnd: Date): readonly DunningStep[] {
  return [
    {
      offsetDays: -5,
      notification: 'RENEWAL_REMINDER_5D',
      at: new Date(periodEnd.getTime() - 5 * DAY_MS),
    },
    {
      offsetDays: -3,
      notification: 'RENEWAL_REMINDER_3D',
      at: new Date(periodEnd.getTime() - 3 * DAY_MS),
    },
    {
      offsetDays: -1,
      notification: 'RENEWAL_REMINDER_1D',
      at: new Date(periodEnd.getTime() - DAY_MS),
    },
  ];
}

export function graceSteps(failedAt: Date): {
  readonly reminder: DunningStep;
  readonly finalDay: DunningStep;
  readonly suspendAt: Date;
} {
  return {
    reminder: {
      offsetDays: 1,
      notification: 'GRACE_PERIOD_REMINDER',
      at: new Date(failedAt.getTime() + DAY_MS),
    },
    finalDay: {
      offsetDays: 2,
      notification: 'GRACE_PERIOD_FINAL_DAY',
      at: new Date(failedAt.getTime() + 2 * DAY_MS),
    },
    suspendAt: new Date(failedAt.getTime() + 3 * DAY_MS),
  };
}
