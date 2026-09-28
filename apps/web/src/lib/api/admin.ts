export interface AdminStats {
  readonly tenants: {
    readonly total: number;
    readonly active: number;
    readonly provisioning: number;
    readonly suspended: number;
    readonly new_30d: number;
  };
  readonly phone_numbers_active: number;
  readonly staff_active: number;
}

export interface AdminTenantRow {
  readonly id: string;
  readonly display_name: string;
  readonly legal_name: string;
  readonly slug: string;
  readonly status: string;
  readonly status_reason: string | null;
  readonly plan_code: string | null;
  readonly billing_market: string;
  readonly trust_tier: string;
  readonly default_locale: string;
  readonly created_at: string | null;
  readonly member_count: number;
  readonly location_count: number;
  readonly phone_number_count: number;
}

export interface AdminTenantPage {
  readonly data: readonly AdminTenantRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface AdminTenantPhoneNumber {
  readonly id: string;
  readonly e164: string;
  readonly status: string;
  readonly provider: string;
}

export interface AdminTenantDetail extends Omit<AdminTenantRow, 'created_at'> {
  readonly status_changed_at: string | null;
  readonly vertical_pack: string;
  readonly timezone: string;
  readonly created_at: string | null;
  readonly owner_email: string | null;
  readonly agent_count: number;
  readonly phone_numbers: readonly AdminTenantPhoneNumber[];
  readonly provisioning_state: string | null;
  readonly subscription_status: string | null;
  readonly subscription_period_end: string | null;
  readonly published_agent_count: number;
}

export interface AdminAuditRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly workspace_name: string | null;
  readonly occurred_at: string | null;
  readonly actor: {
    readonly type: string;
    readonly id: string | null;
    readonly label: string | null;
  };
  readonly action: string;
  readonly object_type: string;
  readonly object_id: string | null;
  readonly metadata: Record<string, unknown>;
  readonly support_grant_id: string | null;
  readonly trace_id: string | null;
}

export interface AdminStaffRow {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly platform_role: string;
  readonly active: boolean;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}
