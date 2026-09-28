import type { AgentConfig } from '@velyric/contracts';

export type AgentStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export interface AgentVersionSummary {
  readonly id: string;
  readonly agent_id: string;
  readonly version_number: number;
  readonly status: string;
  readonly config_hash: string;
  readonly schema_version: number;
  readonly rollout_percent: number | null;
  readonly change_summary: string | null;
  readonly based_on_version_id: string | null;
  readonly simulation_run_id: string | null;
  readonly published_at: string | null;
  readonly superseded_at: string | null;
  readonly rolled_back_at: string | null;
  readonly created_at: string;
}

export interface AgentVersionDetail extends AgentVersionSummary {
  readonly config: AgentConfig;
}

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly status: AgentStatus;
  readonly location_id: string | null;
  readonly vertical_pack: string | null;
  readonly production_version_id: string | null;
  readonly canary_version_id: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AgentDetail extends Agent {
  readonly production_version: AgentVersionSummary | null;
  readonly canary_version: AgentVersionSummary | null;
}

export interface PhoneNumber {
  readonly id: string;
  readonly e164: string;
  readonly country: string;
  readonly number_type: string;
  readonly status: string;
  readonly provider: string;
  readonly location_id: string | null;
  readonly max_concurrent_calls: number;
  readonly retention_until: string | null;
  readonly agent: { readonly id: string; readonly name: string } | null;
  readonly version: number;
  readonly created_at: string;
}

export interface CustomToolSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly side_effect_class: string;
}

export interface ToolOption {
  readonly name: string;
  readonly sideEffectClass: string;
  readonly custom: boolean;
}
