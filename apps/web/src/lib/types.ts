import type { CallIntentCategory, CallOutcome, CallStatus } from '@velyric/contracts';

export interface WorkspaceDetail {
  readonly id: string;
  readonly legal_name: string;
  readonly display_name: string;
  readonly slug: string;
  readonly status: string;
  readonly default_locale: string;
  readonly timezone: string;
  readonly billing_market: string;
  readonly plan_code: string | null;
  readonly trust_tier: string;
  readonly vertical_pack: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CallListItem {
  readonly id: string;
  readonly status: CallStatus;
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly channel: 'PSTN' | 'WEB_VOICE' | 'SIMULATION';
  readonly caller_e164: string | null;
  readonly language: string | null;
  readonly location_id: string | null;
  readonly agent_id: string | null;
  readonly agent_version_id: string | null;
  readonly intent: CallIntentCategory | null;
  readonly outcome: CallOutcome | null;
  readonly end_reason: string | null;
  readonly conversation_state: string | null;
  readonly started_at: string;
  readonly answered_at: string | null;
  readonly ended_at: string | null;
  readonly duration_seconds: number | null;
  readonly quality_score: number | null;
}

export interface TranscriptSegment {
  readonly seq: number;
  readonly speaker: 'CALLER' | 'AGENT' | 'SYSTEM' | 'HUMAN_AGENT';
  readonly language: string | null;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly content: string;
  readonly redaction_state: string;
}

export interface CallDetail extends CallListItem {
  readonly summary: string | null;
  readonly billable_seconds: number | null;
  readonly cost_usd_micros: number | null;
  readonly trace_id: string | null;
  readonly events: readonly {
    readonly seq: number;
    readonly type: string;
    readonly occurred_at: string;
  }[];
  readonly tool_runs: readonly {
    readonly id: string;
    readonly tool: string;
    readonly specialist: string | null;
    readonly status: string;
    readonly error_code: string | null;
    readonly latency_ms: number | null;
    readonly created_at: string;
  }[];
  readonly transfers: readonly {
    readonly id: string;
    readonly transfer_type: string;
    readonly trigger: string;
    readonly state: string;
    readonly destination_label: string;
    readonly failure_reason: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
  }[];
  readonly quality: {
    readonly rubric_version: string;
    readonly overall_score: number;
    readonly flags: readonly string[];
  } | null;
  readonly transcript: readonly TranscriptSegment[] | null;
}

export interface AnalyticsOverview {
  readonly range: { readonly from: string; readonly to: string; readonly timezone: string };
  readonly totals: {
    readonly calls_total: number;
    readonly resolved_by_ai: number;
    readonly transferred_to_human: number;
    readonly abandoned: number;
    readonly rejected: number;
    readonly web_voice_calls: number;
    readonly bookings_created: number;
    readonly connected_minutes: number;
    readonly avg_connected_seconds: number | null;
    readonly cost_usd_micros: number;
    readonly avg_quality_score: number | null;
    readonly containment_rate: number | null;
    readonly transfer_rate: number | null;
    readonly abandonment_rate: number | null;
  };
  readonly daily: readonly {
    readonly date: string;
    readonly calls_total: number;
    readonly resolved_by_ai: number;
    readonly transferred_to_human: number;
    readonly abandoned: number;
    readonly avg_connected_seconds: number | null;
    readonly avg_quality_score: number | null;
  }[];
  readonly hourly: readonly { readonly hour: number; readonly calls_total: number }[];
  readonly intents: readonly {
    readonly intent: string;
    readonly calls_total: number;
    readonly containment_rate: number | null;
  }[];
  readonly languages: readonly { readonly language: string; readonly calls_total: number }[];
  readonly tools: readonly {
    readonly tool_name: string;
    readonly runs_total: number;
    readonly success_rate: number | null;
    readonly latency_p95_ms: number | null;
  }[];
  readonly knowledge_gaps: readonly {
    readonly id: string;
    readonly question: string;
    readonly occurrences: number;
    readonly language: string | null;
    readonly last_seen_at: string;
  }[];
}
