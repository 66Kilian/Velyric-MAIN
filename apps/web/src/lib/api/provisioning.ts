export interface ProvisioningRequirement {
  readonly id: string;
  readonly field_type: string;
  readonly label_key: string;
  readonly status: string;
  readonly decline_reason: string | null;
  readonly submitted_at: string | null;
  readonly reviewed_at: string | null;
}

export interface PhoneOrder {
  readonly id: string;
  readonly e164: string | null;
  readonly country: string;
  readonly number_type: string;
  readonly status: string;
  readonly requirements_status: string;
  readonly decline_reason: string | null;
  readonly reserved_until: string | null;
  readonly phone_number_id: string | null;
  readonly version: number;
  readonly requirements: readonly ProvisioningRequirement[];
}

export interface ProvisioningStatus {
  readonly workflow: {
    readonly id: string;
    readonly order_id: string;
    readonly state: string;
    readonly blocking_reason: string | null;
    readonly manual_review_reason: string | null;
    readonly started_at: string | null;
    readonly completed_at: string | null;
    readonly updated_at: string | null;
  } | null;
  readonly steps: readonly {
    readonly step: string;
    readonly status: string;
    readonly attempt: number;
    readonly error_code: string | null;
    readonly started_at: string | null;
    readonly finished_at: string | null;
  }[];
  readonly phone_orders: readonly PhoneOrder[];
}
