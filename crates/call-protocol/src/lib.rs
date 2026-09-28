#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanaryRoute {
    pub agent_version_id: Uuid,
    pub rollout_percent: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntitlementSummary {
    pub entitlement_version: i64,
    pub max_concurrent_calls: u32,
    pub number_concurrency: Option<u32>,
    pub max_call_duration_seconds: Option<u64>,
    pub features: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpendSummary {
    pub daily_cap_usd_micros: u64,
    pub monthly_cap_usd_micros: u64,
    pub consumed_usd_micros: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoutingSnapshot {
    pub tenant_id: Uuid,
    pub tenant_status: String,
    pub timezone: String,
    pub default_locale: String,
    pub location_id: Option<Uuid>,
    pub phone_number_id: Uuid,
    pub agent_id: Option<Uuid>,
    pub production_agent_version_id: Option<Uuid>,
    pub canary: Option<CanaryRoute>,
    pub entitlement: Option<EntitlementSummary>,
    pub spend: Option<SpendSummary>,
    pub kill_switches: Vec<String>,
    pub admission_block_reason: Option<String>,
    pub valid_until: String,
}

impl RoutingSnapshot {
    #[must_use]
    pub fn select_agent_version(&self, bucket: u8) -> Option<Uuid> {
        match &self.canary {
            Some(canary) if bucket < canary.rollout_percent.min(100) => Some(canary.agent_version_id),
            _ => self.production_agent_version_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Persona {
    pub warmth: u8,
    pub formality: u8,
    pub energy: u8,
    pub pace: u8,
    pub brevity: u8,
    pub empathy: u8,
    pub humor: u8,
    pub assertiveness: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanguageConfig {
    pub locale: String,
    pub greeting: String,
    pub fallback: String,
    pub closing: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Disclosure {
    pub version: String,
    pub texts: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpecialistConfig {
    pub kind: String,
    pub enabled: bool,
    pub tool_allowlist: Vec<String>,
    pub max_tool_executions: u32,
    pub model_tier: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffDestination {
    pub label: String,
    pub e164: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DtmfBindingConfig {
    pub sequence: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffConfig {
    pub destinations: Vec<HandoffDestination>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_destination_label: Option<String>,
    pub dtmf: Vec<DtmfBindingConfig>,
    pub warm_transfer: bool,
    pub failed_understandings_before_offer: u8,
    pub no_answer_behavior: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitsConfig {
    pub max_call_duration_seconds: u64,
    pub max_tool_executions_per_call: u32,
    pub max_spend_usd_micros_per_call: u64,
    pub silence_timeout_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusinessHoursEntry {
    pub iso_weekday: u8,
    pub opens: String,
    pub closes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AfterHoursConfig {
    pub behavior: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_call_destination_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordingConfig {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverloadConfig {
    pub policy: String,
    pub max_wait_seconds: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow_destination_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PronunciationEntry {
    pub term: String,
    pub spoken_as: String,
    pub locale: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRoutingConfig {
    pub complex_escalation_enabled: bool,
    pub premium_reasoning_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentConfig {
    pub schema_version: u32,
    pub voice: String,
    pub default_locale: String,
    pub persona: Persona,
    pub languages: Vec<LanguageConfig>,
    pub disclosure: Disclosure,
    pub specialists: Vec<SpecialistConfig>,
    pub handoff: HandoffConfig,
    pub limits: LimitsConfig,
    pub timezone: String,
    pub business_hours: Vec<BusinessHoursEntry>,
    pub after_hours: AfterHoursConfig,
    pub recording: RecordingConfig,
    pub overload: OverloadConfig,
    pub pronunciation: Vec<PronunciationEntry>,
    pub model_routing: ModelRoutingConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolContract {
    pub name: String,
    pub description: String,
    pub kind: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub side_effect_class: String,
    pub confirmation_policy: String,
    pub timeout_ms: u32,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSnapshot {
    pub snapshot_id: String,
    pub tenant_id: Uuid,
    pub agent_id: Uuid,
    pub agent_version_id: Uuid,
    pub version_number: u32,
    pub status: String,
    pub config_hash: String,
    pub schema_version: u32,
    pub disclosure_version: String,
    pub config: Value,
    pub tools: Vec<ToolContract>,
    pub generated_at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("agent snapshot config hash mismatch: expected {expected}, computed {computed}")]
    HashMismatch { expected: String, computed: String },
    #[error("agent snapshot config does not match the runtime contract: {0}")]
    Config(#[from] serde_json::Error),
}

impl AgentSnapshot {
    pub fn verified_config(&self) -> Result<AgentConfig, SnapshotError> {
        let computed = config_hash(&self.config);
        if computed != self.config_hash {
            return Err(SnapshotError::HashMismatch { expected: self.config_hash.clone(), computed });
        }
        Ok(serde_json::from_value(self.config.clone())?)
    }
}

fn write_canonical(value: &Value, output: &mut String) {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<&String, &Value> = map.iter().collect();
            output.push('{');
            for (index, (key, item)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&Value::String(key.clone()).to_string());
                output.push(':');
                write_canonical(item, output);
            }
            output.push('}');
        }
        Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical(item, output);
            }
            output.push(']');
        }
        other => output.push_str(&other.to_string()),
    }
}

#[must_use]
pub fn canonical_json(value: &Value) -> String {
    let mut output = String::new();
    write_canonical(value, &mut output);
    output
}

#[must_use]
pub fn config_hash(value: &Value) -> String {
    hex::encode(Sha256::digest(canonical_json(value).as_bytes()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolConfirmation {
    pub confirmed_at: String,
    pub confirmation_turn_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolExecutionRequest {
    pub tenant_id: Uuid,
    pub call_id: Option<Uuid>,
    pub agent_version_id: Uuid,
    pub specialist: String,
    pub tool_name: String,
    pub arguments: Map<String, Value>,
    pub conversation_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<ToolConfirmation>,
    pub verified_identity: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolExecutionResponse {
    pub tool_run_id: Uuid,
    pub status: String,
    pub result: Value,
    pub error_code: Option<String>,
    pub retryable: bool,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CallUpsert {
    pub provider: String,
    pub provider_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realtime_session_ref: Option<String>,
    pub channel: String,
    pub direction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_e164: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_version_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admission_decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admission_reject_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub billable_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd_micros: Option<u64>,
    pub trace_id: String,
    pub runtime_instance_id: String,
    pub recording_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallEventRecord {
    pub event_id: Uuid,
    pub seq: u64,
    pub event_type: String,
    pub schema_version: u32,
    pub occurred_at: String,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub seq: u64,
    pub speaker: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub start_ms: u64,
    pub end_ms: u64,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallEventsBatch {
    pub events: Vec<CallEventRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transcript: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeCommand {
    Transfer {
        call_id: Uuid,
        transfer_attempt_id: Uuid,
        destination_e164: String,
        transfer_type: String,
        reason: String,
        requested_by: String,
    },
    Terminate {
        call_id: Uuid,
        reason: String,
        requested_by: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeCommandReply {
    pub accepted: bool,
    pub state: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretReference {
    pub secret_ref: String,
    pub secret_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TenantOpenAiCredentials {
    pub tenant_id: Uuid,
    pub api_key: Option<SecretReference>,
    pub webhook_secret: Option<SecretReference>,
}

pub const KNOWLEDGE_SEARCH_TOOL: &str = "search_knowledge";
pub const KNOWLEDGE_EMBEDDING_MODEL: &str = "text-embedding-3-small";
pub const KNOWLEDGE_EMBEDDING_DIMENSIONS: usize = 1536;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnowledgeSearchRequest {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    pub limit: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnowledgeSearchResult {
    pub chunk_id: Uuid,
    pub source_id: Uuid,
    pub source_title: String,
    pub source_type: String,
    pub content: String,
    pub heading_path: Vec<String>,
    pub language: Option<String>,
    pub freshness: String,
    pub last_synced_at: Option<String>,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnowledgeSearchResponse {
    pub mode: String,
    pub results: Vec<KnowledgeSearchResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageRecord {
    pub source_event_id: Uuid,
    pub tenant_id: Uuid,
    pub call_id: Option<Uuid>,
    pub metric: String,
    pub quantity: i64,
    pub unit: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub occurred_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_keys_recursively_and_is_stable() {
        let left = json!({ "b": 1, "a": { "d": [3, { "z": true, "y": null }], "c": "é\"q" } });
        let right = json!({ "a": { "c": "é\"q", "d": [3, { "y": null, "z": true }] }, "b": 1 });
        assert_eq!(canonical_json(&left), r#"{"a":{"c":"é\"q","d":[3,{"y":null,"z":true}]},"b":1}"#);
        assert_eq!(config_hash(&left), config_hash(&right));
        assert_eq!(config_hash(&json!({})), "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    }

    #[test]
    fn verified_config_rejects_tampered_snapshots() {
        let config = json!({ "schema_version": 1 });
        let snapshot = AgentSnapshot {
            snapshot_id: "s".into(),
            tenant_id: Uuid::nil(),
            agent_id: Uuid::nil(),
            agent_version_id: Uuid::nil(),
            version_number: 1,
            status: "PRODUCTION".into(),
            config_hash: "0".repeat(64),
            schema_version: 1,
            disclosure_version: "2026-09-01.1".into(),
            config,
            tools: vec![],
            generated_at: "2026-09-14T00:00:00Z".into(),
        };
        assert!(matches!(snapshot.verified_config(), Err(SnapshotError::HashMismatch { .. })));
    }

    #[test]
    fn canary_routing_uses_the_rollout_bucket() {
        let production = Uuid::from_u128(1);
        let canary = Uuid::from_u128(2);
        let routing = RoutingSnapshot {
            tenant_id: Uuid::nil(),
            tenant_status: "ACTIVE".into(),
            timezone: "Europe/Budapest".into(),
            default_locale: "hu".into(),
            location_id: None,
            phone_number_id: Uuid::nil(),
            agent_id: Some(Uuid::nil()),
            production_agent_version_id: Some(production),
            canary: Some(CanaryRoute { agent_version_id: canary, rollout_percent: 20 }),
            entitlement: None,
            spend: None,
            kill_switches: vec![],
            admission_block_reason: None,
            valid_until: "2026-09-14T00:01:00Z".into(),
        };
        assert_eq!(routing.select_agent_version(0), Some(canary));
        assert_eq!(routing.select_agent_version(19), Some(canary));
        assert_eq!(routing.select_agent_version(20), Some(production));
        assert_eq!(routing.select_agent_version(99), Some(production));
    }

    #[test]
    fn call_upsert_omits_absent_optional_fields_for_the_strict_api_schema() -> Result<(), serde_json::Error> {
        let upsert = CallUpsert {
            provider: "openai".into(),
            provider_call_id: "rtc_1".into(),
            channel: "PSTN".into(),
            direction: "INBOUND".into(),
            status: "IN_PROGRESS".into(),
            started_at: "2026-09-14T10:00:00Z".into(),
            trace_id: "4bf92f3577b34da6a3ce929d0e0e4736".into(),
            runtime_instance_id: "rt-1".into(),
            ..CallUpsert::default()
        };
        let encoded = serde_json::to_value(&upsert)?;
        assert!(encoded.get("ended_at").is_none());
        assert!(encoded.get("caller_e164").is_none());
        assert_eq!(encoded.get("recording_enabled"), Some(&json!(false)));
        Ok(())
    }

    #[test]
    fn runtime_commands_round_trip_in_snake_case() -> Result<(), serde_json::Error> {
        let raw = json!({
            "type": "TRANSFER",
            "call_id": "0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e5f",
            "transfer_attempt_id": "0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e60",
            "destination_e164": "+3613456789",
            "transfer_type": "WARM",
            "reason": "caller asked for a human",
            "requested_by": "user-1"
        });
        let command: RuntimeCommand = serde_json::from_value(raw.clone())?;
        assert!(matches!(command, RuntimeCommand::Transfer { ref destination_e164, .. } if destination_e164 == "+3613456789"));
        assert_eq!(serde_json::to_value(&command)?, raw);
        Ok(())
    }
}
