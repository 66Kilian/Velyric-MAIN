export const NON_RETRYABLE_ERROR = 'NonRetryableProvisioningError';

export interface ProvisioningInput {
  readonly orderId: string;
  readonly tenantId: string;
  readonly traceId: string;
}

export interface ProvisioningStatus {
  readonly state: string;
  readonly blockingReason: string | null;
  readonly manualReviewReason: string | null;
}

export interface BeginProvisioningResult {
  readonly workflowRowId: string;
  readonly state: string;
  readonly country: string;
  readonly locationId: string | null;
  readonly planCode: string;
  readonly alreadyActive: boolean;
}

export interface PhoneReservationResult {
  readonly phoneOrderId: string;
  readonly e164: string;
  readonly requirementsRequired: boolean;
}

export interface PhoneOrderProgress {
  readonly status: 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'DECLINED';
  readonly declineReason: string | null;
}

export interface AgentReadiness {
  readonly ready: boolean;
  readonly reason: string | null;
}

export interface GoLiveEvaluation {
  readonly eligible: boolean;
  readonly failures: readonly string[];
}

export type NotifyChannel = 'EMAIL' | 'SMS';

export interface NotifyInput {
  readonly tenantId: string;
  readonly type: string;
  readonly dedupeKey: string;
  readonly recipientMembershipId?: string;
  readonly channel?: NotifyChannel;
  readonly payload: Readonly<Record<string, string>>;
  readonly traceId: string;
}

export type GuestEventType = 'booking.created' | 'booking.changed' | 'booking.canceled';

export interface GuestNotificationInput {
  readonly tenantId: string;
  readonly eventType: GuestEventType;
  readonly bookingId: string;
  readonly eventId: string;
  readonly traceId: string;
}

export interface NotifyResult {
  readonly status: 'SENT' | 'ALREADY_SENT' | 'SUPPRESSED';
}

export interface StateInput {
  readonly tenantId: string;
  readonly workflowRowId: string;
  readonly state: string;
  readonly blockingReason: string | null;
  readonly traceId: string;
}

export interface WorkflowRowInput {
  readonly tenantId: string;
  readonly workflowRowId: string;
  readonly traceId: string;
}

export interface ProvisioningActivities {
  beginProvisioning(
    input: ProvisioningInput & { readonly workflowId: string },
  ): Promise<BeginProvisioningResult>;
  recordState(input: StateInput): Promise<void>;
  ensureOrderInvoice(input: WorkflowRowInput & { readonly orderId: string }): Promise<void>;
  ensureTenantProvisioning(input: WorkflowRowInput): Promise<void>;
  ensureOpenAiProject(input: WorkflowRowInput & { readonly planCode: string }): Promise<string>;
  ensureOpenAiServiceAccount(
    input: WorkflowRowInput & { readonly projectId: string },
  ): Promise<void>;
  reservePhoneNumber(
    input: WorkflowRowInput & { readonly orderId: string; readonly country: string },
  ): Promise<PhoneReservationResult>;
  requirementsSubmitted(
    input: WorkflowRowInput & { readonly phoneOrderId: string },
  ): Promise<boolean>;
  orderPhoneNumber(
    input: WorkflowRowInput & { readonly phoneOrderId: string; readonly orderId: string },
  ): Promise<void>;
  refreshPhoneOrder(
    input: WorkflowRowInput & { readonly phoneOrderId: string },
  ): Promise<PhoneOrderProgress>;
  activatePhoneNumber(
    input: WorkflowRowInput & { readonly phoneOrderId: string; readonly locationId: string | null },
  ): Promise<string>;
  checkAgentReadiness(
    input: WorkflowRowInput & { readonly phoneNumberId: string },
  ): Promise<AgentReadiness>;
  evaluateGoLive(
    input: WorkflowRowInput & { readonly phoneNumberId: string },
  ): Promise<GoLiveEvaluation>;
  completeProvisioning(input: WorkflowRowInput): Promise<void>;
  markManualReview(
    input: WorkflowRowInput & { readonly reason: string; readonly errorMessage: string },
  ): Promise<void>;
  compensateProvisioning(input: WorkflowRowInput & { readonly reason: string }): Promise<void>;
  notify(input: NotifyInput): Promise<NotifyResult>;
}

export interface InvoiceIssuanceInput {
  readonly tenantId: string;
  readonly stripeInvoiceId: string;
  readonly orderId: string | null;
  readonly traceId: string;
}

export interface InvoiceIssuanceResult {
  readonly status: 'CREATED' | 'SENT' | 'SEND_FAILED' | 'ALREADY_ISSUED';
  readonly billingDocumentId: string;
  readonly invoiceNumber: string | null;
}

export interface RenewalRemindersInput {
  readonly tenantId: string;
  readonly stripeSubscriptionId: string;
  readonly periodEnd: string;
  readonly traceId: string;
}

export interface RenewalSchedule {
  readonly steps: readonly { readonly at: string; readonly notification: string }[];
  readonly payload: Readonly<Record<string, string>>;
}

export interface DunningInput {
  readonly tenantId: string;
  readonly stripeInvoiceId: string;
  readonly traceId: string;
}

export interface GraceSchedule {
  readonly alreadyPaid: boolean;
  readonly reminderAt: string;
  readonly finalDayAt: string;
  readonly suspendAt: string;
  readonly payload: Readonly<Record<string, string>>;
}

export interface BillingActivities {
  issueInvoiceDocument(input: InvoiceIssuanceInput): Promise<InvoiceIssuanceResult>;
  renewalSchedule(input: RenewalRemindersInput): Promise<RenewalSchedule>;
  subscriptionRenewsAt(input: RenewalRemindersInput): Promise<boolean>;
  enterGracePeriod(input: DunningInput): Promise<GraceSchedule>;
  invoiceIsPaid(input: DunningInput): Promise<boolean>;
  suspendForNonPayment(input: DunningInput): Promise<boolean>;
  notify(input: NotifyInput): Promise<NotifyResult>;
}

export interface NotificationActivities {
  notify(input: NotifyInput): Promise<NotifyResult>;
  guestNotifications(input: GuestNotificationInput): Promise<readonly NotifyInput[]>;
  offerReleasedSlot(input: GuestNotificationInput): Promise<readonly NotifyInput[]>;
}

export interface ErasureInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface ErasureResult {
  readonly outcome: 'COMPLETED' | 'ALREADY_COMPLETED' | 'ON_LEGAL_HOLD' | 'NOT_APPLICABLE';
  readonly affected: Readonly<Record<string, number>>;
}

export interface PrivacyActivities {
  eraseCallerData(input: ErasureInput): Promise<ErasureResult>;
}

export interface TenantRetentionInput {
  readonly tenantId: string;
  readonly jobRunId: string;
  readonly traceId: string;
}

export interface TenantRetentionResult {
  readonly tenantId: string;
  readonly affected: Readonly<Record<string, number>>;
}

export interface RetentionSweepResult {
  readonly jobRunId: string;
  readonly tenants: number;
  readonly failedTenants: readonly string[];
  readonly providerPayloads: number;
}

export interface RetentionActivities {
  listRetentionTenants(): Promise<readonly string[]>;
  applyTenantRetention(input: TenantRetentionInput): Promise<TenantRetentionResult>;
  applyPlatformRetention(input: { readonly jobRunId: string }): Promise<number>;
}
