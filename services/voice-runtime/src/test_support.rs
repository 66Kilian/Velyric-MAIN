use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use secrecy::SecretString;
use url::Url;

use crate::admission::{AdmissionGate, AdmissionLimits};
use crate::config::{Environment, ModelCatalog, ProviderMode};
use crate::control_api::ControlApiClient;
use crate::incoming::{RuntimeSettings, RuntimeState};
use crate::metrics::Metrics;
use crate::openai::OpenAiLiveClient;
use crate::registry::Registry;
use crate::secrets::SecretResolver;
use crate::session::SessionTiming;
use crate::webhook_signature::WebhookSecret;

use base64::Engine;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::EncodePrivateKey;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use serde_json::{Value, json};
use uuid::Uuid;
use velyric_call_protocol::{AgentSnapshot, EntitlementSummary, RoutingSnapshot, SpendSummary, ToolContract, config_hash};
use velyric_runtime_policy::service_auth::{ServiceAuthError, ServiceSigner, ServiceVerifier};

pub struct TestKeys {
    pem: String,
    x: String,
    kid: String,
}

impl TestKeys {
    pub fn new(seed: u8) -> Result<Self, Box<dyn Error>> {
        let signing = SigningKey::from_bytes(&[seed; 32]);
        let pem = signing.to_pkcs8_pem(LineEnding::LF)?.to_string();
        let x = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signing.verifying_key().as_bytes());
        Ok(Self { pem, x, kid: format!("test-key-{seed}") })
    }

    pub fn signer(&self, issuer: &str) -> Result<ServiceSigner, ServiceAuthError> {
        ServiceSigner::from_pkcs8_pem(issuer, &self.kid, self.pem.as_bytes())
    }

    #[must_use]
    pub fn jwks(&self) -> String {
        json!({ "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": self.x, "kid": self.kid, "alg": "EdDSA", "use": "sig" }] }).to_string()
    }

    pub fn verifier(&self, audience: &str) -> Result<ServiceVerifier, ServiceAuthError> {
        ServiceVerifier::from_jwks_json(audience, &self.jwks())
    }
}

#[must_use]
pub fn agent_config_json() -> Value {
    json!({
        "schema_version": 1,
        "voice": "marin",
        "default_locale": "hu",
        "persona": { "warmth": 70, "formality": 60, "energy": 50, "pace": 50, "brevity": 70, "empathy": 60, "humor": 10, "assertiveness": 40 },
        "languages": [
            { "locale": "hu", "greeting": "Jó napot, a Demo Rendelő asszisztense vagyok.", "fallback": "Elnézést, ezt nem értettem.", "closing": "Köszönöm a hívást, viszonthallásra." },
            { "locale": "en", "greeting": "Hello, this is the Demo Clinic assistant.", "fallback": "Sorry, I did not catch that.", "closing": "Thank you for calling, goodbye." }
        ],
        "disclosure": {
            "version": "2026-09-01.1",
            "texts": {
                "hu": "Mesterséges intelligencia alapú asszisztens vagyok, a hívás minőségbiztosítási célból feldolgozásra kerül.",
                "en": "I am an AI assistant and this call is processed for quality assurance."
            }
        },
        "specialists": [
            { "kind": "RECEPTION_ROUTER", "enabled": true, "tool_allowlist": ["search_knowledge"], "max_tool_executions": 3, "model_tier": "ROUTINE" },
            { "kind": "BOOKING", "enabled": true, "tool_allowlist": ["lookup_availability", "create_booking"], "max_tool_executions": 5, "model_tier": "ROUTINE" },
            { "kind": "HANDOFF_COMPLIANCE", "enabled": true, "tool_allowlist": [], "max_tool_executions": 0, "model_tier": "ROUTINE" }
        ],
        "handoff": {
            "destinations": [{ "label": "front-desk", "e164": "+3612345678", "description": "Recepció" }],
            "default_destination_label": "front-desk",
            "dtmf": [{ "sequence": "###", "action": "HUMAN_TRANSFER", "destination_label": "front-desk" }],
            "warm_transfer": false,
            "failed_understandings_before_offer": 2,
            "no_answer_behavior": "RETURN_TO_AI"
        },
        "limits": { "max_call_duration_seconds": 1800, "max_tool_executions_per_call": 10, "max_spend_usd_micros_per_call": 2_000_000, "silence_timeout_seconds": 12 },
        "timezone": "Europe/Budapest",
        "business_hours": [
            { "iso_weekday": 1, "opens": "08:00", "closes": "18:00" },
            { "iso_weekday": 2, "opens": "08:00", "closes": "18:00" },
            { "iso_weekday": 3, "opens": "08:00", "closes": "18:00" },
            { "iso_weekday": 4, "opens": "08:00", "closes": "18:00" },
            { "iso_weekday": 5, "opens": "08:00", "closes": "16:00" }
        ],
        "after_hours": { "behavior": "TAKE_MESSAGE" },
        "recording": { "enabled": false },
        "overload": { "policy": "SHORT_QUEUE", "max_wait_seconds": 0 },
        "pronunciation": [{ "term": "Velyric", "spoken_as": "Velirik", "locale": "hu" }],
        "model_routing": { "complex_escalation_enabled": false, "premium_reasoning_enabled": false }
    })
}

#[must_use]
pub fn tools() -> Vec<ToolContract> {
    vec![
        ToolContract {
            name: "lookup_availability".into(),
            description: "Find free appointment slots".into(),
            kind: "BUILT_IN".into(),
            input_schema: json!({ "type": "object", "properties": { "date": { "type": "string" } }, "required": ["date"], "additionalProperties": false }),
            output_schema: json!({ "type": "object" }),
            side_effect_class: "READ".into(),
            confirmation_policy: "NONE".into(),
            timeout_ms: 3_000,
            active: true,
        },
        ToolContract {
            name: "create_booking".into(),
            description: "Create a confirmed booking".into(),
            kind: "BUILT_IN".into(),
            input_schema: json!({ "type": "object", "properties": { "slot_id": { "type": "string" }, "name": { "type": "string" } }, "required": ["slot_id", "name"], "additionalProperties": false }),
            output_schema: json!({ "type": "object" }),
            side_effect_class: "WRITE".into(),
            confirmation_policy: "CALLER_CONFIRMATION".into(),
            timeout_ms: 5_000,
            active: true,
        },
        ToolContract {
            name: "search_knowledge".into(),
            description: "Search the practice knowledge base".into(),
            kind: "BUILT_IN".into(),
            input_schema: json!({ "type": "object", "properties": { "query": { "type": "string", "minLength": 2, "maxLength": 300 } }, "required": ["query"], "additionalProperties": false }),
            output_schema: json!({ "type": "object" }),
            side_effect_class: "READ".into(),
            confirmation_policy: "NONE".into(),
            timeout_ms: 3_000,
            active: true,
        },
    ]
}

#[must_use]
pub fn agent_snapshot(tenant_id: Uuid, agent_version_id: Uuid) -> AgentSnapshot {
    let config = agent_config_json();
    let hash = config_hash(&config);
    AgentSnapshot {
        snapshot_id: format!("{agent_version_id}:{hash}"),
        tenant_id,
        agent_id: Uuid::from_u128(0xa6e7),
        agent_version_id,
        version_number: 3,
        status: "PRODUCTION".into(),
        config_hash: hash,
        schema_version: 1,
        disclosure_version: "2026-09-01.1".into(),
        config,
        tools: tools(),
        generated_at: "2026-09-14T10:00:00Z".into(),
    }
}

#[must_use]
pub fn routing_snapshot(tenant_id: Uuid, agent_version_id: Uuid) -> RoutingSnapshot {
    RoutingSnapshot {
        tenant_id,
        tenant_status: "ACTIVE".into(),
        timezone: "Europe/Budapest".into(),
        default_locale: "hu".into(),
        location_id: None,
        phone_number_id: Uuid::from_u128(0x9e0),
        agent_id: Some(Uuid::from_u128(0xa6e7)),
        production_agent_version_id: Some(agent_version_id),
        canary: None,
        entitlement: Some(EntitlementSummary {
            entitlement_version: 1,
            max_concurrent_calls: 2,
            number_concurrency: None,
            max_call_duration_seconds: Some(1_800),
            features: json!({}),
        }),
        spend: Some(SpendSummary { daily_cap_usd_micros: 20_000_000, monthly_cap_usd_micros: 300_000_000, consumed_usd_micros: 0 }),
        kill_switches: vec![],
        admission_block_reason: None,
        valid_until: "2099-01-01T00:00:00Z".into(),
    }
}

pub const WEBHOOK_SECRET: &str = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

pub fn runtime_state(control_base: &str, openai_base: &str, sideband_base: Option<&str>, seed: u8) -> Result<Arc<RuntimeState>, Box<dyn Error>> {
    crate::install_crypto_provider();
    let keys = TestKeys::new(seed)?;
    let control = Arc::new(ControlApiClient::new(
        reqwest::Client::builder().build()?,
        Url::parse(control_base)?,
        Arc::new(keys.signer("voice-runtime")?),
        None,
        "ci",
    ));
    let mut openai = OpenAiLiveClient::new(reqwest::Client::builder().build()?, Url::parse(openai_base)?)?;
    if let Some(sideband) = sideband_base {
        openai = openai.with_sideband_base(Url::parse(sideband)?);
    }
    Ok(Arc::new(RuntimeState {
        settings: RuntimeSettings {
            instance_id: "rt-test".into(),
            provider_mode: ProviderMode::Simulator,
            models: ModelCatalog {
                live: "gpt-live-1".into(),
                routine: "gpt-5.6-luna".into(),
                complex: "gpt-5.6-terra".into(),
                escalation: "gpt-5.6-sol".into(),
                frontier: "gpt-6-astra".into(),
            },
            backend_max_output_tokens: 1_024,
            live_usd_micros_per_minute: 50_000,
        },
        control,
        openai: Arc::new(openai),
        gate: Arc::new(AdmissionGate::new(
            None,
            Environment::Ci,
            "eu-central-1",
            AdmissionLimits { global_max_calls: 10, provider_max_calls: 10, fallback_max_calls_per_tenant: 4, lease: Duration::from_secs(30) },
        )),
        registry: Arc::new(Registry::default()),
        metrics: Arc::new(Metrics::new(crate::METRICS_PREFIX)),
        secrets: Arc::new(SecretResolver::new("eu-central-1", false)),
        jetstream: None,
        platform_webhook_secret: WebhookSecret::parse(WEBHOOK_SECRET)?,
        platform_api_key: Arc::new(SecretString::from("sk-sim".to_owned())),
        timing: SessionTiming::default(),
        seen_webhooks: DashMap::new(),
    }))
}
