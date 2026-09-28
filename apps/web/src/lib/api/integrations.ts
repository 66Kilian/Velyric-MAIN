export type ConnectorType = 'GOOGLE_CALENDAR' | 'MICROSOFT_365';

export interface Integration {
  readonly id: string;
  readonly integration_type: string;
  readonly provider: string;
  readonly display_name: string | null;
  readonly status: string;
  readonly location_id: string | null;
  readonly granted_scopes: readonly string[];
  readonly external_account_ref: string | null;
  readonly last_error_code: string | null;
  readonly last_health_check_at: string | null;
  readonly disconnected_at: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export type SideEffectClass = 'READ' | 'WRITE' | 'HIGH_RISK_WRITE' | 'EXTERNAL_COMMUNICATION';
export type ConfirmationPolicy =
  'NONE' | 'CALLER_CONFIRMATION' | 'CALLER_CONFIRMATION_WITH_VERIFICATION' | 'HUMAN_APPROVAL';

export interface CustomTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: 'ACTIVE' | 'DISABLED' | 'KILLED';
  readonly http_method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly base_url: string;
  readonly path_template: string;
  readonly allowed_hosts: readonly string[];
  readonly input_schema: Readonly<Record<string, unknown>>;
  readonly output_schema: Readonly<Record<string, unknown>>;
  readonly side_effect_class: SideEffectClass;
  readonly confirmation_policy: ConfirmationPolicy;
  readonly idempotency_supported: boolean;
  readonly timeout_ms: number;
  readonly max_retries: number;
  readonly response_max_bytes: number;
  readonly auth_type: 'NONE' | 'BEARER' | 'HMAC';
  readonly credential_configured: boolean;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}
