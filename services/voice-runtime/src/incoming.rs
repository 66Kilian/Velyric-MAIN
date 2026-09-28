use std::sync::Arc;
use std::time::{Duration, Instant};

use async_nats::jetstream;
use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use jiff::Timestamp;
use secrecy::ExposeSecret;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use uuid::Uuid;
use velyric_call_protocol::{AgentConfig, AgentSnapshot, CallEventRecord, CallEventsBatch, CallUpsert, RoutingSnapshot};
use velyric_runtime_policy::admission::AdmissionRequest;
use velyric_runtime_policy::language::{LanguageInputs, resolve_language};

use crate::admission::{AdmissionGate, AdmissionVerdict};
use crate::config::{ModelCatalog, ProviderMode};
use crate::control_api::ControlApiClient;
use crate::events::{self, SinkContext};
use crate::metrics::Metrics;
use crate::openai::{AcceptRequest, AcceptSession, AudioConfig, AudioOutput, Delegation, IncomingCallData, OpenAiLiveClient, valid_session_id};
use crate::prompt::{self, PromptInputs};
use crate::registry::{Registry, SessionHandle};
use crate::secrets::{SecretError, SecretResolver, SharedSecret};
use crate::session::{self, SessionContext, SessionDeps, SessionTiming};
use crate::sip::{self, SipCallParties};
use crate::webhook_signature::WebhookSecret;

const MAX_QUEUE_WAIT: Duration = Duration::from_secs(20);
const OVERFLOW_ANNOUNCE_DELAY: Duration = Duration::from_secs(3);

pub struct RuntimeSettings {
    pub instance_id: String,
    pub provider_mode: ProviderMode,
    pub models: ModelCatalog,
    pub backend_max_output_tokens: u32,
    pub live_usd_micros_per_minute: u64,
}

pub struct RuntimeState {
    pub settings: RuntimeSettings,
    pub control: Arc<ControlApiClient>,
    pub openai: Arc<OpenAiLiveClient>,
    pub gate: Arc<AdmissionGate>,
    pub registry: Arc<Registry>,
    pub metrics: Arc<Metrics>,
    pub secrets: Arc<SecretResolver>,
    pub jetstream: Option<jetstream::Context>,
    pub platform_webhook_secret: WebhookSecret,
    pub platform_api_key: SharedSecret,
    pub timing: SessionTiming,
    pub seen_webhooks: DashMap<String, Instant>,
}

impl RuntimeState {
    pub fn first_delivery(&self, webhook_id: &str) -> bool {
        let now = Instant::now();
        if self.seen_webhooks.len() > 10_000 {
            self.seen_webhooks.retain(|_, seen| now.duration_since(*seen) < Duration::from_secs(600));
        }
        match self.seen_webhooks.entry(webhook_id.to_owned()) {
            Entry::Occupied(_) => false,
            Entry::Vacant(vacant) => {
                vacant.insert(now);
                true
            }
        }
    }

    fn fallback_key(&self) -> Option<SharedSecret> {
        Some(Arc::clone(&self.platform_api_key))
    }

    pub async fn tenant_webhook_secret(&self, tenant_id: Uuid, trace_id: &str) -> Result<WebhookSecret, &'static str> {
        let credentials = self.control.openai_credentials(tenant_id, trace_id).await.map_err(|_| "credentials_unavailable")?;
        let Some(reference) = credentials.webhook_secret else {
            return if self.settings.provider_mode == ProviderMode::Live { Err("webhook_secret_missing") } else { Ok(self.platform_webhook_secret.clone()) };
        };
        match self.secrets.resolve_reference(&reference.secret_ref).await {
            Ok(secret) => WebhookSecret::parse(secret.expose_secret()).map_err(|_| "webhook_secret_invalid"),
            Err(SecretError::RemoteDisabled) => Ok(self.platform_webhook_secret.clone()),
            Err(_) => Err("webhook_secret_unavailable"),
        }
    }

    pub async fn api_key(&self, tenant_id: Uuid, trace_id: &str) -> Option<SharedSecret> {
        let reference = match self.control.openai_credentials(tenant_id, trace_id).await {
            Ok(credentials) => credentials.api_key.filter(|_| credentials.webhook_secret.is_some()),
            Err(error) => {
                warn!(error = %error, %tenant_id, "tenant OpenAI credentials unavailable");
                None
            }
        };
        if let Some(reference) = reference {
            match self.secrets.resolve_reference(&reference.secret_ref).await {
                Ok(secret) => return Some(secret),
                Err(SecretError::RemoteDisabled) => {}
                Err(error) => warn!(error = %error, %tenant_id, "tenant OpenAI key could not be resolved"),
            }
        }
        self.fallback_key()
    }
}

fn sip_status(reason: &str) -> u16 {
    match reason {
        "TENANT_SUSPENDED" | "ENTITLEMENT_INACTIVE" | "SPEND_CAP_REACHED" | "FRAUD_BLOCK" | "TENANT_MISMATCH" => 403,
        "NUMBER_INACTIVE" | "NUMBER_NOT_ROUTED" | "INVALID_SIP_HEADERS" => 404,
        "NO_PRODUCTION_AGENT" => 480,
        "TENANT_CONCURRENCY_LIMIT" | "LOCATION_CONCURRENCY_LIMIT" | "NUMBER_CONCURRENCY_LIMIT" | "CPS_LIMIT" => 486,
        _ => 503,
    }
}

#[must_use]
pub fn rollout_bucket(call_id: Uuid) -> u8 {
    Sha256::digest(call_id.as_bytes()).first().copied().unwrap_or(0) % 100
}

struct Setup<'a> {
    state: &'a RuntimeState,
    call_id: Uuid,
    trace_id: String,
    session_id: String,
    parties: SipCallParties,
    started_at: OffsetDateTime,
}

struct Record<'a> {
    status: &'a str,
    decision: &'a str,
    reject_reason: Option<&'a str>,
    end_reason: &'a str,
}

impl Setup<'_> {
    async fn reject(&self, api_key: Option<&SharedSecret>, reason: &str) {
        self.state.metrics.increment("admission_rejected", "reason", reason);
        match api_key {
            Some(key) => {
                if let Err(error) = self.state.openai.reject(key, &self.session_id, sip_status(reason)).await {
                    warn!(error = %error, call_id = %self.call_id, reason, "incoming call rejection failed");
                }
            }
            None => warn!(call_id = %self.call_id, reason, "no OpenAI credential available to reject the incoming call; it will time out"),
        }
    }

    async fn record(&self, routing: &RoutingSnapshot, snapshot: Option<&AgentSnapshot>, record: Record<'_>) {
        let now = crate::rfc3339(OffsetDateTime::now_utc());
        let body = CallUpsert {
            provider: "openai".into(),
            provider_call_id: self.session_id.clone(),
            realtime_session_ref: Some(self.session_id.clone()),
            channel: "PSTN".into(),
            direction: "INBOUND".into(),
            caller_e164: self.parties.caller_e164.clone(),
            phone_number_id: Some(routing.phone_number_id),
            location_id: routing.location_id,
            agent_id: snapshot.map(|snapshot| snapshot.agent_id).or(routing.agent_id),
            agent_version_id: snapshot.map(|snapshot| snapshot.agent_version_id),
            status: record.status.into(),
            admission_decision: Some(record.decision.into()),
            admission_reject_reason: record.reject_reason.map(str::to_owned),
            end_reason: Some(record.end_reason.into()),
            started_at: crate::rfc3339(self.started_at),
            ended_at: Some(now.clone()),
            connected_seconds: Some(0),
            billable_seconds: Some(0),
            cost_usd_micros: Some(0),
            trace_id: self.trace_id.clone(),
            runtime_instance_id: self.state.settings.instance_id.clone(),
            recording_enabled: false,
            ..CallUpsert::default()
        };
        if let Err(error) = self.state.control.upsert_call(routing.tenant_id, self.call_id, &body, &self.trace_id).await {
            warn!(error = %error, call_id = %self.call_id, "unadmitted call could not be recorded");
            return;
        }
        let payload: Map<String, Value> = json!({ "decision": record.decision, "reason": record.reject_reason, "end_reason": record.end_reason })
            .as_object()
            .cloned()
            .unwrap_or_default();
        let batch = CallEventsBatch {
            events: vec![CallEventRecord {
                event_id: Uuid::now_v7(),
                seq: 1,
                event_type: "call.admission_decided".into(),
                schema_version: 1,
                occurred_at: now,
                payload,
            }],
            transcript: Vec::new(),
        };
        if let Err(error) = self.state.control.post_events(routing.tenant_id, self.call_id, &batch, &self.trace_id).await {
            warn!(error = %error, call_id = %self.call_id, "admission event could not be recorded");
        }
    }

    async fn reject_and_record(&self, api_key: &SharedSecret, routing: &RoutingSnapshot, snapshot: Option<&AgentSnapshot>, reason: &str, end_reason: &str) {
        self.reject(Some(api_key), reason).await;
        self.record(routing, snapshot, Record { status: "REJECTED", decision: "REJECTED", reject_reason: Some(reason), end_reason }).await;
    }
}

pub async fn handle_incoming(state: Arc<RuntimeState>, data: IncomingCallData, expected_tenant: Option<Uuid>) {
    let started = Instant::now();
    state.metrics.add_pending_setups(1);
    let outcome = setup_call(&state, data, expected_tenant).await;
    state.metrics.add_pending_setups(-1);
    state.metrics.observe_ms("call_setup", "outcome", outcome, u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX));
}

async fn admit(state: &RuntimeState, admission: &AdmissionRequest, config: &AgentConfig) -> Result<bool, (&'static str, &'static str)> {
    let wait = if config.overload.policy == "SHORT_QUEUE" { Duration::from_secs(u64::from(config.overload.max_wait_seconds)).min(MAX_QUEUE_WAIT) } else { Duration::ZERO };
    let deadline = Instant::now() + wait;
    let mut queued = false;
    loop {
        match state.gate.acquire(admission, &state.metrics).await {
            Ok(AdmissionVerdict::Admitted { degraded }) => {
                if queued {
                    state.metrics.increment("admission_queue", "result", "admitted");
                }
                return Ok(degraded);
            }
            Ok(AdmissionVerdict::Rejected { reason }) => {
                if Instant::now() + Duration::from_secs(1) <= deadline && !state.registry.is_draining() {
                    queued = true;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                if queued {
                    state.metrics.increment("admission_queue", "result", "timeout");
                }
                return Err((reason, if queued { "QUEUE_TIMEOUT" } else { "ADMISSION_REJECTED" }));
            }
            Err(error) => {
                error!(error = %error, "admission request is invalid");
                return Err(("GLOBAL_CAPACITY", "ADMISSION_REJECTED"));
            }
        }
    }
}

async fn overflow(setup: &Setup<'_>, routing: &RoutingSnapshot, snapshot: &AgentSnapshot, config: &AgentConfig, api_key: &SharedSecret, destination: &str, reason: &str) {
    let locale = prompt::default_locale(config);
    let request = AcceptRequest {
        session: AcceptSession {
            kind: "live",
            model: setup.state.settings.models.live.clone(),
            instructions: format!(
                "All colleagues are currently busy with other callers. In {}, say one short, friendly sentence that you are connecting the caller to a colleague now, then stay silent.",
                prompt::language_name(locale)
            ),
            audio: AudioConfig { output: AudioOutput { voice: config.voice.clone() } },
            delegation: Delegation::Client,
            store: false,
        },
    };
    let result = async {
        setup.state.openai.accept(api_key, &setup.session_id, &request).await?;
        tokio::time::sleep(OVERFLOW_ANNOUNCE_DELAY).await;
        setup.state.openai.refer(api_key, &setup.session_id, &format!("tel:{destination}")).await
    }
    .await;
    match result {
        Ok(()) => {
            setup.state.metrics.increment("admission_overflow", "result", "referred");
            setup
                .record(routing, Some(snapshot), Record { status: "TRANSFERRED", decision: "OVERFLOWED", reject_reason: Some(reason), end_reason: "TRANSFER_COMPLETED" })
                .await;
        }
        Err(error) => {
            warn!(error = %error, call_id = %setup.call_id, "overflow transfer failed");
            setup.state.metrics.increment("admission_overflow", "result", "failed");
            if let Err(error) = setup.state.openai.hangup(api_key, &setup.session_id).await {
                warn!(error = %error, call_id = %setup.call_id, "overflow hangup failed");
            }
            setup
                .record(routing, Some(snapshot), Record { status: "FAILED", decision: "OVERFLOWED", reject_reason: Some(reason), end_reason: "PROVIDER_FAILURE" })
                .await;
        }
    }
}

async fn setup_call(state: &Arc<RuntimeState>, data: IncomingCallData, expected_tenant: Option<Uuid>) -> &'static str {
    if !valid_session_id(&data.session_id) {
        state.metrics.increment("admission_rejected", "reason", "INVALID_SESSION_ID");
        return "invalid_session";
    }
    let call_id = Uuid::now_v7();
    let trace_id = crate::new_trace_id();
    let parties = match sip::parse_parties(&data.sip_headers) {
        Ok(parties) => parties,
        Err(error) => {
            warn!(error = %error, %call_id, "incoming call has unusable SIP headers");
            let key = match expected_tenant {
                Some(tenant_id) => state.api_key(tenant_id, &trace_id).await,
                None => state.fallback_key(),
            };
            let setup = Setup {
                state,
                call_id,
                trace_id,
                session_id: data.session_id,
                parties: SipCallParties { dialed_e164: String::new(), caller_e164: None, sip_call_id: None, carrier: "telnyx" },
                started_at: OffsetDateTime::now_utc(),
            };
            setup.reject(key.as_ref(), "INVALID_SIP_HEADERS").await;
            return "invalid_sip_headers";
        }
    };
    let setup = Setup { state, call_id, trace_id, session_id: data.session_id, parties, started_at: OffsetDateTime::now_utc() };
    let routing = match state.control.routing(setup.parties.carrier, &setup.parties.dialed_e164, &setup.trace_id).await {
        Ok(routing) => routing,
        Err(error) => {
            let reason = if error.is_not_found() { "NUMBER_NOT_ROUTED" } else { "ROUTING_UNAVAILABLE" };
            warn!(error = %error, %call_id, reason, "incoming call routing failed");
            let key = match expected_tenant {
                Some(tenant_id) => state.api_key(tenant_id, &setup.trace_id).await,
                None => state.fallback_key(),
            };
            setup.reject(key.as_ref(), reason).await;
            return "routing_failed";
        }
    };
    if let Some(expected) = expected_tenant.filter(|expected| *expected != routing.tenant_id) {
        error!(%call_id, %expected, routed = %routing.tenant_id, "webhook tenant does not own the dialed number");
        let key = state.api_key(expected, &setup.trace_id).await;
        setup.reject(key.as_ref(), "TENANT_MISMATCH").await;
        return "tenant_mismatch";
    }
    let Some(api_key) = state.api_key(routing.tenant_id, &setup.trace_id).await else {
        error!(%call_id, tenant_id = %routing.tenant_id, "no OpenAI credential available for the tenant");
        setup.state.metrics.increment("admission_rejected", "reason", "CREDENTIALS_UNAVAILABLE");
        setup
            .record(&routing, None, Record { status: "REJECTED", decision: "REJECTED", reject_reason: Some("SNAPSHOT_UNAVAILABLE"), end_reason: "PROVIDER_FAILURE" })
            .await;
        return "credentials_unavailable";
    };
    if state.registry.is_draining() {
        setup.reject_and_record(&api_key, &routing, None, "RUNTIME_DRAINING", "ADMISSION_REJECTED").await;
        return "draining";
    }
    if let Some(reason) = routing.admission_block_reason.as_deref() {
        if reason == "NUMBER_INACTIVE" {
            setup.reject(Some(&api_key), reason).await;
        } else {
            setup.reject_and_record(&api_key, &routing, None, reason, "ADMISSION_REJECTED").await;
        }
        return "blocked";
    }
    let Some(agent_version_id) = routing.select_agent_version(rollout_bucket(call_id)) else {
        setup.reject_and_record(&api_key, &routing, None, "NO_PRODUCTION_AGENT", "ADMISSION_REJECTED").await;
        return "no_agent";
    };
    let snapshot = match state.control.agent_snapshot(routing.tenant_id, agent_version_id, &setup.trace_id).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            warn!(error = %error, %call_id, "agent snapshot unavailable");
            setup.reject_and_record(&api_key, &routing, None, "SNAPSHOT_UNAVAILABLE", "ADMISSION_REJECTED").await;
            return "snapshot_unavailable";
        }
    };
    let config = match snapshot.verified_config() {
        Ok(config) => config,
        Err(error) => {
            error!(error = %error, %call_id, "agent snapshot does not satisfy the runtime contract");
            setup.reject_and_record(&api_key, &routing, Some(&snapshot), "SNAPSHOT_UNAVAILABLE", "ADMISSION_REJECTED").await;
            return "snapshot_invalid";
        }
    };
    let admission = match state.gate.request(call_id, &routing, "openai") {
        Ok(admission) => admission,
        Err(reason) => {
            setup.reject_and_record(&api_key, &routing, Some(&snapshot), reason, "ADMISSION_REJECTED").await;
            return "entitlement_inactive";
        }
    };
    let degraded = match admit(state, &admission, &config).await {
        Ok(degraded) => degraded,
        Err((reason, end_reason)) => {
            let overflow_destination = (config.overload.policy == "HUMAN_OVERFLOW")
                .then_some(config.overload.overflow_destination_label.as_ref())
                .flatten()
                .and_then(|label| config.handoff.destinations.iter().find(|destination| &destination.label == label))
                .map(|destination| destination.e164.clone());
            if let Some(destination) = overflow_destination {
                overflow(&setup, &routing, &snapshot, &config, &api_key, &destination, reason).await;
                return "overflowed";
            }
            setup.reject_and_record(&api_key, &routing, Some(&snapshot), reason, end_reason).await;
            return "capacity_rejected";
        }
    };
    let tenant_default = prompt::default_locale(&config);
    let (locale, language_source) = resolve_language(LanguageInputs {
        explicit_request: None,
        confirmed_preference: None,
        detected: None,
        caller_e164: setup.parties.caller_e164.as_deref(),
        tenant_default,
    });
    let clock = prompt::local_clock(&config, Timestamp::now());
    let inputs = PromptInputs {
        config: &config,
        tools: &snapshot.tools,
        locale,
        models: &state.settings.models,
        max_output_tokens: state.settings.backend_max_output_tokens,
        clock: &clock,
    };
    let request = prompt::accept_request(&inputs);
    let backend_model = prompt::backend_model(&config, &state.settings.models).0.to_owned();
    if let Err(error) = state.openai.accept(&api_key, &setup.session_id, &request).await {
        error!(error = %error, %call_id, "OpenAI accept failed");
        state.gate.release(&admission).await;
        setup.record(&routing, Some(&snapshot), Record { status: "FAILED", decision: "ADMITTED", reject_reason: None, end_reason: "PROVIDER_FAILURE" }).await;
        state.metrics.increment("provider_failures", "operation", "accept");
        return "accept_failed";
    }
    let stream = match state.openai.attach(&api_key, &setup.session_id).await {
        Ok(stream) => stream,
        Err(error) => {
            error!(error = %error, %call_id, "OpenAI sideband attach failed");
            if let Err(error) = state.openai.hangup(&api_key, &setup.session_id).await {
                warn!(error = %error, %call_id, "hangup after attach failure failed");
            }
            state.gate.release(&admission).await;
            setup.record(&routing, Some(&snapshot), Record { status: "FAILED", decision: "ADMITTED", reject_reason: None, end_reason: "PROVIDER_FAILURE" }).await;
            state.metrics.increment("provider_failures", "operation", "attach");
            return "attach_failed";
        }
    };
    let tenant_id = routing.tenant_id;
    let context = SessionContext {
        call_id,
        tenant_id,
        trace_id: setup.trace_id.clone(),
        session_id: setup.session_id.clone(),
        routing: Arc::clone(&routing),
        snapshot: Arc::clone(&snapshot),
        config,
        locale,
        language_source,
        caller_e164: setup.parties.caller_e164.clone(),
        api_key: Arc::clone(&api_key),
        admission,
        admission_degraded: degraded,
        started_at: setup.started_at,
        backend_model,
    };
    let mut upsert = session::base_upsert(&context, &state.settings.instance_id, "IN_PROGRESS");
    upsert.answered_at = Some(crate::rfc3339(OffsetDateTime::now_utc()));
    upsert.conversation_state = Some("GREETING".into());
    if let Err(error) = state.control.upsert_call(tenant_id, call_id, &upsert, &setup.trace_id).await {
        warn!(error = %error, %call_id, "in-progress call state could not be recorded");
    }
    let (sink, sink_task) = events::spawn(SinkContext {
        control: Arc::clone(&state.control),
        jetstream: state.jetstream.clone(),
        metrics: Arc::clone(&state.metrics),
        tenant_id,
        call_id,
        trace_id: setup.trace_id.clone(),
    });
    let (commands, receiver) = mpsc::channel(16);
    state.registry.insert(call_id, SessionHandle { tenant_id, commands });
    let deps = SessionDeps {
        control: Arc::clone(&state.control),
        openai: Arc::clone(&state.openai),
        gate: Arc::clone(&state.gate),
        registry: Arc::clone(&state.registry),
        metrics: Arc::clone(&state.metrics),
        sink,
        timing: state.timing,
        live_usd_micros_per_minute: state.settings.live_usd_micros_per_minute,
        live_model: state.settings.models.live.clone(),
        instance_id: state.settings.instance_id.clone(),
    };
    tokio::spawn(async move {
        session::run(context, deps, stream, receiver).await;
        let _ = sink_task.await;
    });
    info!(%call_id, %tenant_id, "incoming call admitted");
    "admitted"
}

#[cfg(test)]
mod tests;
