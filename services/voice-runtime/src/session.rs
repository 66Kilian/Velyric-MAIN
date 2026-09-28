use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use secrecy::SecretString;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tokio::time::{Interval, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};
use uuid::Uuid;
use velyric_call_protocol::{
    AgentConfig, AgentSnapshot, CallEventRecord, CallUpsert, KNOWLEDGE_EMBEDDING_DIMENSIONS, KNOWLEDGE_EMBEDDING_MODEL, KNOWLEDGE_SEARCH_TOOL,
    KnowledgeSearchRequest, KnowledgeSearchResponse, RoutingSnapshot, RuntimeCommand, RuntimeCommandReply, ToolConfirmation, ToolExecutionRequest,
    ToolExecutionResponse, TranscriptSegment, UsageRecord, canonical_json,
};
use velyric_common_observability::redact_e164;
use velyric_runtime_policy::admission::AdmissionRequest;
use velyric_runtime_policy::conversation::{ConversationEvent, ConversationState, transition};
use velyric_runtime_policy::cost_guard::{CostGuard, CostLimits, GuardVerdict, StopReason};
use velyric_runtime_policy::dtmf::{DtmfAction, DtmfBinding, DtmfMatcher, parse_digit};
use velyric_runtime_policy::language::{LanguageSource, Locale};

use crate::admission::AdmissionGate;
use crate::control_api::ControlApiClient;
use crate::events::EventSink;
use crate::metrics::Metrics;
use crate::openai::{
    ClientEvent, DelegatedResponseEvent, OpenAiLiveClient, ServerEvent, SidebandStream, classify_response_event, client_event_id,
    function_call_output, milliseconds,
};
use crate::prompt::{self, MetaTool};
use crate::registry::{Registry, SessionCommand, ShutdownReason};

const READ_STATES: [ConversationState; 7] = [
    ConversationState::Discovery,
    ConversationState::Identity,
    ConversationState::ActionPreview,
    ConversationState::ConfirmationGate,
    ConversationState::ToolExecution,
    ConversationState::ResultConfirmation,
    ConversationState::FollowUp,
];

#[derive(Debug, Clone, Copy)]
pub struct SessionTiming {
    pub tick: Duration,
    pub segment_idle: Duration,
    pub filler_after: Duration,
    pub hangup_grace: Duration,
    pub close_timeout: Duration,
    pub dtmf_inter_digit: Duration,
    pub disclosure_reminder_after: Duration,
    pub warm_transfer_delay: Duration,
    pub reconnect_delays: [Duration; 3],
}

impl Default for SessionTiming {
    fn default() -> Self {
        Self {
            tick: Duration::from_millis(250),
            segment_idle: Duration::from_millis(900),
            filler_after: Duration::from_millis(1_500),
            hangup_grace: Duration::from_secs(8),
            close_timeout: Duration::from_secs(10),
            dtmf_inter_digit: Duration::from_secs(2),
            disclosure_reminder_after: Duration::from_secs(15),
            warm_transfer_delay: Duration::from_secs(3),
            reconnect_delays: [Duration::from_millis(250), Duration::from_secs(1), Duration::from_secs(2)],
        }
    }
}

const MAX_KNOWLEDGE_QUERY_CHARS: usize = 300;
const MAX_KNOWLEDGE_PASSAGE_CHARS: usize = 1200;
const KNOWLEDGE_RESULT_LIMIT: u8 = 4;
const EMBEDDING_TIMEOUT: Duration = Duration::from_millis(1800);

fn knowledge_tool_response(response: KnowledgeSearchResponse) -> ToolExecutionResponse {
    let passages: Vec<Value> = response
        .results
        .iter()
        .map(|result| {
            json!({
                "source_title": result.source_title,
                "section": result.heading_path.join(" / "),
                "content": result.content.chars().take(MAX_KNOWLEDGE_PASSAGE_CHARS).collect::<String>(),
                "freshness": result.freshness,
            })
        })
        .collect();
    let instruction = if passages.is_empty() {
        "No matching knowledge was found. Say that you are not sure and offer a callback or a human instead of guessing."
    } else {
        "Answer only from these passages. If they do not answer the question, say so and offer a human."
    };
    ToolExecutionResponse {
        tool_run_id: Uuid::now_v7(),
        status: "SUCCEEDED".to_owned(),
        result: json!({ "mode": response.mode, "results": passages, "instruction": instruction }),
        error_code: None,
        retryable: false,
        replayed: false,
    }
}

pub struct SessionDeps {
    pub control: Arc<ControlApiClient>,
    pub openai: Arc<OpenAiLiveClient>,
    pub gate: Arc<AdmissionGate>,
    pub registry: Arc<Registry>,
    pub metrics: Arc<Metrics>,
    pub sink: EventSink,
    pub timing: SessionTiming,
    pub live_usd_micros_per_minute: u64,
    pub live_model: String,
    pub instance_id: String,
}

pub struct SessionContext {
    pub call_id: Uuid,
    pub tenant_id: Uuid,
    pub trace_id: String,
    pub session_id: String,
    pub routing: Arc<RoutingSnapshot>,
    pub snapshot: Arc<AgentSnapshot>,
    pub config: AgentConfig,
    pub locale: Locale,
    pub language_source: LanguageSource,
    pub caller_e164: Option<String>,
    pub api_key: Arc<SecretString>,
    pub admission: AdmissionRequest,
    pub admission_degraded: bool,
    pub started_at: OffsetDateTime,
    pub backend_model: String,
}

#[must_use]
pub fn base_upsert(context: &SessionContext, instance_id: &str, status: &str) -> CallUpsert {
    CallUpsert {
        provider: "openai".into(),
        provider_call_id: context.session_id.clone(),
        realtime_session_ref: Some(context.session_id.clone()),
        channel: "PSTN".into(),
        direction: "INBOUND".into(),
        caller_e164: context.caller_e164.clone(),
        phone_number_id: Some(context.routing.phone_number_id),
        location_id: context.routing.location_id,
        agent_id: Some(context.snapshot.agent_id),
        agent_version_id: Some(context.snapshot.agent_version_id),
        language: Some(context.locale.as_str().into()),
        status: status.into(),
        admission_decision: Some("ADMITTED".into()),
        started_at: crate::rfc3339(context.started_at),
        trace_id: context.trace_id.clone(),
        runtime_instance_id: instance_id.into(),
        recording_enabled: context.config.recording.enabled,
        ..CallUpsert::default()
    }
}

#[must_use]
pub fn state_name(state: ConversationState) -> String {
    serde_json::to_value(state).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

const fn trigger_name(event: ConversationEvent) -> &'static str {
    match event {
        ConversationEvent::DisclosureDelivered => "DISCLOSURE_DELIVERED",
        ConversationEvent::IntentDetected { .. } => "INTENT_DETECTED",
        ConversationEvent::IdentityVerified => "IDENTITY_VERIFIED",
        ConversationEvent::ActionPrepared => "ACTION_PREPARED",
        ConversationEvent::CallerConfirmed => "CALLER_CONFIRMED",
        ConversationEvent::CallerDeclined => "CALLER_DECLINED",
        ConversationEvent::ToolCompleted { .. } => "TOOL_COMPLETED",
        ConversationEvent::ResultAcknowledged => "RESULT_ACKNOWLEDGED",
        ConversationEvent::FurtherRequest => "FURTHER_REQUEST",
        ConversationEvent::NoFurtherRequests => "NO_FURTHER_REQUESTS",
        ConversationEvent::HandoffRequested => "HANDOFF_REQUESTED",
        ConversationEvent::UnrecoverableError => "UNRECOVERABLE_ERROR",
        ConversationEvent::Hangup => "HANGUP",
    }
}

const fn stop_reason_code(reason: StopReason) -> &'static str {
    match reason {
        StopReason::MaxDurationReached => "MAX_DURATION_REACHED",
        StopReason::SpendCapReached => "SPEND_CAP_REACHED",
        StopReason::ToolBudgetExhausted => "TOOL_BUDGET_EXHAUSTED",
    }
}

fn normalized_tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .chars()
        .map(|character| if character.is_alphanumeric() { character } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

#[must_use]
pub fn disclosure_delivered(expected: &str, spoken: &str) -> bool {
    let expected = normalized_tokens(expected);
    if expected.is_empty() {
        return true;
    }
    let spoken: std::collections::HashSet<String> = normalized_tokens(spoken).into_iter().collect();
    let present = expected.iter().filter(|token| spoken.contains(*token)).count();
    present * 5 >= expected.len() * 4
}

#[must_use]
pub fn action_hash(tool_name: &str, arguments: &Map<String, Value>) -> String {
    let canonical = canonical_json(&json!({ "tool": tool_name, "arguments": arguments }));
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

#[must_use]
pub fn idempotency_key(call_id: Uuid, tool_call_id: &str) -> String {
    let sanitized: String = tool_call_id
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-') { character } else { '_' })
        .take(160)
        .collect();
    format!("{call_id}:{sanitized}")
}

struct SegmentBuffer {
    speaker: &'static str,
    text: String,
    start_ms: u64,
    end_ms: u64,
    last_delta: Instant,
}

struct PendingAction {
    tool_name: String,
    arguments_hash: String,
    prepared_turn: u64,
}

struct ToolInFlight {
    call_id: String,
    started: Instant,
    filler_sent: bool,
}

struct ToolCompletion {
    call_id: String,
    tool_name: String,
    write: bool,
    result: Result<ToolExecutionResponse, String>,
    latency_ms: u64,
    embedding_tokens: u64,
}

#[derive(Clone, Copy)]
struct Closing {
    reason: &'static str,
    deadline: Instant,
    hangup_sent: bool,
}

struct TransferState {
    attempt_id: Uuid,
    destination_e164: String,
    refer_at: Instant,
    referred: bool,
}

enum Step {
    Sideband(Option<Result<Message, tokio_tungstenite::tungstenite::Error>>),
    Command(Option<SessionCommand>),
    Tool(ToolCompletion),
    Tick,
}

struct Session {
    context: SessionContext,
    deps: SessionDeps,
    stream: SidebandStream,
    commands: mpsc::Receiver<SessionCommand>,
    commands_open: bool,
    tool_sender: mpsc::Sender<ToolCompletion>,
    tool_receiver: mpsc::Receiver<ToolCompletion>,
    ticker: Interval,
    state: ConversationState,
    locale: Locale,
    cost_guard: CostGuard,
    dtmf: Option<DtmfMatcher>,
    answered: Instant,
    answered_at: OffsetDateTime,
    event_seq: u64,
    transcript_seq: u64,
    last_caller_turn: u64,
    buffer: Option<SegmentBuffer>,
    greeting_text: String,
    disclosure_reminded: bool,
    last_activity: Instant,
    silence_prompted: bool,
    pending: Option<PendingAction>,
    confirmation: Option<ToolConfirmation>,
    identity_verified: bool,
    in_flight: Option<ToolInFlight>,
    specialist_executions: HashMap<String, u32>,
    intent: Option<String>,
    outcome: Option<String>,
    closing: Option<Closing>,
    transfer: Option<TransferState>,
    wrap_up_sent: bool,
    reported_seconds: u64,
    cost_usd_micros: u64,
    failure: bool,
    last_heartbeat: Instant,
    finished: bool,
}

pub async fn run(context: SessionContext, deps: SessionDeps, stream: SidebandStream, commands: mpsc::Receiver<SessionCommand>) {
    let mut session = Session::new(context, deps, stream, commands);
    session.start().await;
    while !session.finished {
        let step = tokio::select! {
            message = session.stream.next() => Step::Sideband(message),
            command = session.commands.recv(), if session.commands_open => Step::Command(command),
            Some(completion) = session.tool_receiver.recv() => Step::Tool(completion),
            _ = session.ticker.tick() => Step::Tick,
        };
        match step {
            Step::Sideband(message) => session.on_sideband(message).await,
            Step::Command(Some(command)) => session.on_command(command).await,
            Step::Command(None) => session.commands_open = false,
            Step::Tool(completion) => session.on_tool_completion(completion).await,
            Step::Tick => session.on_tick().await,
        }
    }
}

impl Session {
    fn new(context: SessionContext, deps: SessionDeps, stream: SidebandStream, commands: mpsc::Receiver<SessionCommand>) -> Self {
        let config = &context.config;
        let entitlement_limit = context.routing.entitlement.as_ref().and_then(|entitlement| entitlement.max_call_duration_seconds);
        let max_duration = entitlement_limit.map_or(config.limits.max_call_duration_seconds, |limit| limit.min(config.limits.max_call_duration_seconds));
        let spend = context.routing.spend.as_ref();
        let limits = CostLimits {
            max_call_duration: Duration::from_secs(max_duration),
            max_tool_executions: config.limits.max_tool_executions_per_call,
            max_spend_usd_micros_per_call: config.limits.max_spend_usd_micros_per_call,
            remaining_daily_spend_usd_micros: None,
            remaining_monthly_spend_usd_micros: spend
                .filter(|spend| spend.monthly_cap_usd_micros > 0)
                .map(|spend| spend.monthly_cap_usd_micros.saturating_sub(spend.consumed_usd_micros)),
        };
        let bindings: Vec<DtmfBinding> = config
            .handoff
            .dtmf
            .iter()
            .filter_map(|binding| {
                let action = match binding.action.as_str() {
                    "HUMAN_TRANSFER" => DtmfAction::HumanTransfer { destination_label: binding.destination_label.clone() },
                    "BACK" => DtmfAction::Back,
                    "REPEAT_MENU" => DtmfAction::RepeatMenu,
                    _ => return None,
                };
                Some(DtmfBinding { sequence: binding.sequence.clone(), action })
            })
            .collect();
        let dtmf = match DtmfMatcher::new(bindings, deps.timing.dtmf_inter_digit) {
            Ok(matcher) => Some(matcher),
            Err(error) => {
                warn!(error = %error, "agent DTMF bindings are invalid; DTMF handling disabled for this call");
                None
            }
        };
        let mut ticker = tokio::time::interval(deps.timing.tick);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let (tool_sender, tool_receiver) = mpsc::channel(16);
        let locale = context.locale;
        let now = Instant::now();
        Self {
            context,
            deps,
            stream,
            commands,
            commands_open: true,
            tool_sender,
            tool_receiver,
            ticker,
            state: ConversationState::Greeting,
            locale,
            cost_guard: CostGuard::new(limits),
            dtmf,
            answered: now,
            answered_at: OffsetDateTime::now_utc(),
            event_seq: 0,
            transcript_seq: 0,
            last_caller_turn: 0,
            buffer: None,
            greeting_text: String::new(),
            disclosure_reminded: false,
            last_activity: now,
            silence_prompted: false,
            pending: None,
            confirmation: None,
            identity_verified: false,
            in_flight: None,
            specialist_executions: HashMap::new(),
            intent: None,
            outcome: None,
            closing: None,
            transfer: None,
            wrap_up_sent: false,
            reported_seconds: 0,
            cost_usd_micros: 0,
            failure: false,
            last_heartbeat: now,
            finished: false,
        }
    }

    async fn start(&mut self) {
        self.deps.metrics.add_active_calls(1);
        let language_source = serde_json::to_value(self.context.language_source).unwrap_or(Value::Null);
        self.event("call.admission_decided", json!({ "decision": "ADMITTED", "degraded": self.context.admission_degraded })).await;
        self.event(
            "call.started",
            json!({
                "agent_version_id": self.context.snapshot.agent_version_id,
                "config_hash": self.context.snapshot.config_hash,
                "disclosure_version": self.context.snapshot.disclosure_version,
                "language": self.locale.as_str(),
                "language_source": language_source,
                "backend_model": self.context.backend_model,
                "runtime_instance_id": self.deps.instance_id,
            }),
        )
        .await;
        info!(call_id = %self.context.call_id, tenant_id = %self.context.tenant_id, "call session started");
    }

    async fn event(&mut self, event_type: &str, payload: Value) {
        self.event_seq += 1;
        let payload = match payload {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        self.deps
            .sink
            .event(CallEventRecord {
                event_id: Uuid::now_v7(),
                seq: self.event_seq,
                event_type: event_type.to_owned(),
                schema_version: 1,
                occurred_at: crate::rfc3339(OffsetDateTime::now_utc()),
                payload,
            })
            .await;
    }

    async fn advance(&mut self, event: ConversationEvent) -> bool {
        match transition(self.state, event) {
            Ok(next) => {
                if next != self.state {
                    let from = self.state;
                    self.state = next;
                    self.event(
                        "call.conversation_state_changed",
                        json!({ "from": state_name(from), "to": state_name(next), "trigger": trigger_name(event) }),
                    )
                    .await;
                }
                true
            }
            Err(_) => false,
        }
    }

    async fn send(&mut self, event: ClientEvent) {
        match serde_json::to_string(&event) {
            Ok(text) => {
                if let Err(error) = self.stream.send(Message::Text(text.into())).await {
                    warn!(error = %error, call_id = %self.context.call_id, "sideband send failed");
                    self.deps.metrics.increment("sideband_send_errors", "channel", "live");
                }
            }
            Err(error) => error!(error = %error, "client event could not be serialized"),
        }
    }

    async fn instruct(&mut self, content: String) {
        self.send(ClientEvent::InstructionsAppend { content, delegation_id: None, event_id: client_event_id() }).await;
    }

    async fn tool_output(&mut self, call_id: &str, output: Value) {
        self.send(ClientEvent::ResponseItemCreate { item: function_call_output(call_id, &output), event_id: client_event_id() }).await;
        self.send(ClientEvent::ResponseCreate { event_id: client_event_id() }).await;
    }

    fn closing_sentence(&self) -> String {
        prompt::language_config(&self.context.config, self.locale).map_or_else(String::new, |language| language.closing.clone())
    }

    fn request_close(&mut self, reason: &'static str, grace: Duration) {
        if self.closing.is_none() {
            self.closing = Some(Closing { reason, deadline: Instant::now() + grace, hangup_sent: false });
        }
    }

    async fn close_with_message(&mut self, reason: &'static str) {
        if self.closing.is_some() {
            return;
        }
        let closing = self.closing_sentence();
        self.instruct(format!("End the call now. Say exactly: \"{closing}\" and nothing else.")).await;
        self.request_close(reason, self.deps.timing.hangup_grace);
    }

    async fn on_sideband(&mut self, message: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>) {
        match message {
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<ServerEvent>(text.as_str()) {
                Ok(event) => self.on_server_event(event).await,
                Err(error) => {
                    warn!(error = %error, "unparseable sideband event");
                    self.deps.metrics.increment("sideband_parse_errors", "channel", "live");
                }
            },
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => self.on_sideband_lost().await,
            Some(Ok(_)) => {}
        }
    }

    async fn on_sideband_lost(&mut self) {
        if self.closing.is_some_and(|closing| closing.hangup_sent) {
            self.finalize(None).await;
            return;
        }
        self.deps.metrics.increment("sideband_disconnects", "channel", "live");
        for delay in self.deps.timing.reconnect_delays {
            tokio::time::sleep(delay).await;
            match self.deps.openai.attach(&self.context.api_key, &self.context.session_id).await {
                Ok(stream) => {
                    self.stream = stream;
                    self.deps.metrics.increment("sideband_reconnects", "result", "success");
                    warn!(call_id = %self.context.call_id, "sideband reconnected");
                    return;
                }
                Err(error) => warn!(error = %error, call_id = %self.context.call_id, "sideband reconnect failed"),
            }
        }
        self.deps.metrics.increment("sideband_reconnects", "result", "failed");
        if let Err(error) = self.deps.openai.hangup(&self.context.api_key, &self.context.session_id).await {
            warn!(error = %error, call_id = %self.context.call_id, "hangup after sideband loss failed");
        }
        self.failure = true;
        self.request_close("PROVIDER_FAILURE", Duration::ZERO);
        self.finalize(None).await;
    }

    async fn on_server_event(&mut self, event: ServerEvent) {
        match event {
            ServerEvent::SessionStarted { .. } | ServerEvent::DelegationCreated { .. } | ServerEvent::Unknown => {}
            ServerEvent::InputTranscriptDelta { delta, start_ms, end_ms } => self.on_transcript("CALLER", delta, start_ms, end_ms).await,
            ServerEvent::OutputTranscriptDelta { delta, start_ms, end_ms } => self.on_transcript("AGENT", delta, start_ms, end_ms).await,
            ServerEvent::ResponseEvent { event, .. } => match classify_response_event(&event) {
                DelegatedResponseEvent::FunctionCall { call_id, name, arguments } => self.on_function_call(call_id, name, &arguments).await,
                DelegatedResponseEvent::Completed { model, input_tokens, output_tokens } => {
                    self.on_backend_usage(model, input_tokens, output_tokens).await;
                }
                DelegatedResponseEvent::Failed { code } => {
                    let code = code.unwrap_or_else(|| "unknown".to_owned());
                    warn!(call_id = %self.context.call_id, code = %code, "delegated backend response failed");
                    self.deps.metrics.increment("backend_failures", "code", &code);
                }
                DelegatedResponseEvent::Other => {}
            },
            ServerEvent::UsageUpdated { usage } => self.on_usage(usage.seconds).await,
            ServerEvent::DtmfReceived { event } => self.on_dtmf(&event).await,
            ServerEvent::TransportFailed { error } => {
                warn!(call_id = %self.context.call_id, code = ?error.code, "SIP transport failed");
                self.failure = true;
            }
            ServerEvent::Closed { reason, usage } => {
                if let Some(usage) = usage {
                    self.on_usage(usage.seconds).await;
                }
                self.finalize(Some(reason)).await;
            }
            ServerEvent::Error { error } => {
                let code = error.code.or(error.kind).unwrap_or_else(|| "unknown".to_owned());
                warn!(call_id = %self.context.call_id, code = %code, "sideband error event");
                self.deps.metrics.increment("sideband_errors", "code", &code);
            }
        }
    }

    async fn on_transcript(&mut self, speaker: &'static str, delta: String, start_ms: f64, end_ms: f64) {
        if self.buffer.as_ref().is_some_and(|buffer| buffer.speaker != speaker) {
            self.flush_segment().await;
        }
        let now = Instant::now();
        self.last_activity = now;
        if speaker == "CALLER" {
            self.silence_prompted = false;
        }
        match &mut self.buffer {
            Some(buffer) => {
                buffer.text.push_str(&delta);
                buffer.end_ms = buffer.end_ms.max(milliseconds(end_ms));
                buffer.last_delta = now;
            }
            None => {
                self.buffer = Some(SegmentBuffer {
                    speaker,
                    text: delta,
                    start_ms: milliseconds(start_ms),
                    end_ms: milliseconds(end_ms),
                    last_delta: now,
                });
            }
        }
    }

    async fn flush_segment(&mut self) {
        let Some(buffer) = self.buffer.take() else {
            return;
        };
        let content: String = buffer.text.trim().chars().take(8_000).collect();
        if content.is_empty() {
            return;
        }
        self.transcript_seq += 1;
        let seq = self.transcript_seq;
        self.deps
            .sink
            .transcript(TranscriptSegment {
                seq,
                speaker: buffer.speaker.to_owned(),
                language: Some(self.locale.as_str().to_owned()),
                start_ms: buffer.start_ms,
                end_ms: buffer.end_ms.max(buffer.start_ms),
                content: content.clone(),
            })
            .await;
        if buffer.speaker == "CALLER" {
            self.last_caller_turn = seq;
            if self.state == ConversationState::ResultConfirmation {
                self.advance(ConversationEvent::ResultAcknowledged).await;
            }
            return;
        }
        if self.state == ConversationState::Greeting {
            self.greeting_text.push(' ');
            self.greeting_text.push_str(&content);
            let expected = prompt::configured_disclosure(&self.context.config, self.locale).map(str::to_owned);
            let delivered = expected.as_deref().map_or(!self.greeting_text.trim().is_empty(), |expected| disclosure_delivered(expected, &self.greeting_text));
            if delivered && self.advance(ConversationEvent::DisclosureDelivered).await {
                self.event(
                    "call.disclosure_delivered",
                    json!({
                        "disclosure_version": self.context.snapshot.disclosure_version,
                        "locale": self.locale.as_str(),
                        "translated": expected.is_none(),
                        "transcript_seq": seq
                    }),
                )
                .await;
            }
        }
    }

    async fn reach_action_preview(&mut self, needs_identity: bool) -> Result<(), &'static str> {
        for _ in 0..6 {
            let event = match self.state {
                ConversationState::ActionPreview => return Ok(()),
                ConversationState::Greeting => return Err("DISCLOSURE_PENDING"),
                ConversationState::ResultConfirmation => ConversationEvent::ResultAcknowledged,
                ConversationState::FollowUp | ConversationState::SafeFailure => ConversationEvent::FurtherRequest,
                ConversationState::Discovery => ConversationEvent::IntentDetected { requires_identity: needs_identity },
                ConversationState::Identity if self.identity_verified => ConversationEvent::IdentityVerified,
                ConversationState::Identity => return Err("IDENTITY_VERIFICATION_REQUIRED"),
                ConversationState::ConfirmationGate => {
                    self.pending = None;
                    ConversationEvent::CallerDeclined
                }
                ConversationState::ToolExecution
                | ConversationState::Handoff
                | ConversationState::Closing
                | ConversationState::End => return Err("INVALID_STATE_TRANSITION"),
            };
            if !self.advance(event).await {
                return Err("INVALID_STATE_TRANSITION");
            }
        }
        Err("INVALID_STATE_TRANSITION")
    }

    async fn on_function_call(&mut self, call_id: String, name: String, arguments: &str) {
        if self.closing.is_some() {
            self.tool_output(&call_id, json!({ "status": "REJECTED_BY_POLICY", "error_code": "CALL_ENDING" })).await;
            return;
        }
        let arguments = match serde_json::from_str::<Value>(arguments) {
            Ok(Value::Object(map)) => map,
            _ => {
                self.tool_output(&call_id, json!({ "status": "REJECTED_BY_POLICY", "error_code": "TOOL_SCHEMA_INVALID" })).await;
                return;
            }
        };
        if let Some(meta) = MetaTool::from_name(&name) {
            let output = self.on_meta_tool(meta, &arguments).await;
            self.deps.metrics.increment("meta_tool_calls", "tool", meta.name());
            self.tool_output(&call_id, output).await;
            return;
        }
        if let Err(output) = self.dispatch_gateway_tool(call_id.clone(), name, arguments).await {
            self.tool_output(&call_id, output).await;
        }
    }

    async fn on_meta_tool(&mut self, tool: MetaTool, arguments: &Map<String, Value>) -> Value {
        let text = |key: &str| arguments.get(key).and_then(Value::as_str).map(str::to_owned);
        let flag = |key: &str| arguments.get(key).and_then(Value::as_bool);
        let rejected = |code: &str| json!({ "status": "REJECTED_BY_POLICY", "error_code": code });
        match tool {
            MetaTool::ReportIntent => {
                let (Some(intent), Some(requires_identity)) = (text("intent").filter(|intent| prompt::INTENTS.contains(&intent.as_str())), flag("requires_identity"))
                else {
                    return rejected("TOOL_SCHEMA_INVALID");
                };
                self.intent = Some(intent);
                if matches!(self.state, ConversationState::FollowUp | ConversationState::SafeFailure) {
                    self.advance(ConversationEvent::FurtherRequest).await;
                }
                if self.state == ConversationState::Discovery {
                    self.advance(ConversationEvent::IntentDetected { requires_identity: requires_identity && !self.identity_verified }).await;
                }
                json!({ "status": "RECORDED", "conversation_state": state_name(self.state) })
            }
            MetaTool::PrepareAction => {
                let (Some(tool_name), Some(Value::Object(action_arguments)), Some(_summary)) =
                    (text("tool_name"), arguments.get("arguments"), text("summary").filter(|summary| !summary.trim().is_empty()))
                else {
                    return rejected("TOOL_SCHEMA_INVALID");
                };
                let tool = prompt::gateway_tools(&self.context.config, &self.context.snapshot.tools)
                    .into_iter()
                    .find(|tool| tool.name == tool_name && prompt::is_write(tool))
                    .cloned();
                let Some(tool) = tool else {
                    return rejected("TOOL_NOT_ALLOWED");
                };
                let needs_identity = prompt::requires_verified_identity(&tool) && !self.identity_verified;
                if let Err(code) = self.reach_action_preview(needs_identity).await {
                    return rejected(code);
                }
                self.flush_segment().await;
                self.pending = Some(PendingAction {
                    tool_name: tool_name.clone(),
                    arguments_hash: action_hash(&tool_name, action_arguments),
                    prepared_turn: self.transcript_seq,
                });
                self.confirmation = None;
                self.advance(ConversationEvent::ActionPrepared).await;
                json!({
                    "status": "AWAITING_CALLER_CONFIRMATION",
                    "instruction": "Read the summary to the caller, ask for an explicit yes or no, then call call_confirm_action with the answer."
                })
            }
            MetaTool::ConfirmAction => {
                let Some(confirmed) = flag("confirmed") else {
                    return rejected("TOOL_SCHEMA_INVALID");
                };
                let prepared_turn = match (&self.pending, self.state) {
                    (Some(pending), ConversationState::ConfirmationGate) => pending.prepared_turn,
                    _ => return rejected("CONFIRMATION_REQUIRED"),
                };
                self.flush_segment().await;
                if self.last_caller_turn <= prepared_turn {
                    return rejected("CALLER_ANSWER_REQUIRED");
                }
                if confirmed {
                    self.advance(ConversationEvent::CallerConfirmed).await;
                    self.confirmation = Some(ToolConfirmation {
                        confirmed_at: crate::rfc3339(OffsetDateTime::now_utc()),
                        confirmation_turn_seq: self.last_caller_turn,
                    });
                    let tool_name = self.pending.as_ref().map(|pending| pending.tool_name.clone()).unwrap_or_default();
                    json!({ "status": "CONFIRMED", "instruction": format!("Call {tool_name} now with exactly the prepared arguments.") })
                } else {
                    self.pending = None;
                    self.advance(ConversationEvent::CallerDeclined).await;
                    json!({ "status": "DECLINED", "instruction": "Acknowledge the answer and ask how else you can help." })
                }
            }
            MetaTool::RequestHandoff => {
                let destination = text("destination_label").and_then(|label| {
                    self.context.config.handoff.destinations.iter().find(|destination| destination.label == label).map(|destination| destination.e164.clone())
                });
                let Some(destination) = destination else {
                    return rejected("TRANSFER_DESTINATION_NOT_ALLOWED");
                };
                let transfer_type = if self.context.config.handoff.warm_transfer { "WARM" } else { "COLD" };
                let reason = text("reason").unwrap_or_default();
                match self.start_transfer(&destination, transfer_type, &reason, "agent", None).await {
                    Ok(_) => json!({ "status": "TRANSFER_INITIATED", "instruction": "Tell the caller in one short sentence that you are connecting them now." }),
                    Err(code) => rejected(code),
                }
            }
            MetaTool::SetLanguage => {
                let Some(locale) = text("locale").and_then(|value| Locale::parse(&value)) else {
                    return rejected("LANGUAGE_NOT_SUPPORTED");
                };
                if locale != self.locale {
                    let from = self.locale;
                    self.flush_segment().await;
                    self.locale = locale;
                    self.event("call.language_changed", json!({ "from": from.as_str(), "to": locale.as_str(), "source": "EXPLICIT_REQUEST" })).await;
                    self.instruct(format!("The caller is now speaking {}. Answer in {} from now on.", prompt::language_name(locale), prompt::language_name(locale))).await;
                }
                json!({ "status": "SWITCHED", "language": locale.as_str() })
            }
            MetaTool::NextStep => {
                let Some(further) = flag("further_request") else {
                    return rejected("TOOL_SCHEMA_INVALID");
                };
                if self.state == ConversationState::ResultConfirmation {
                    self.advance(ConversationEvent::ResultAcknowledged).await;
                }
                let event = if further { ConversationEvent::FurtherRequest } else { ConversationEvent::NoFurtherRequests };
                self.advance(event).await;
                json!({ "status": "RECORDED", "conversation_state": state_name(self.state) })
            }
            MetaTool::EndCall => {
                let Some(outcome) = text("outcome").filter(|outcome| prompt::END_OUTCOMES.contains(&outcome.as_str())) else {
                    return rejected("TOOL_SCHEMA_INVALID");
                };
                self.outcome = Some(outcome);
                if self.state == ConversationState::ResultConfirmation {
                    self.advance(ConversationEvent::ResultAcknowledged).await;
                }
                self.advance(ConversationEvent::NoFurtherRequests).await;
                self.request_close("AGENT_HANGUP", self.deps.timing.hangup_grace);
                let closing = self.closing_sentence();
                json!({ "status": "ENDING", "instruction": format!("Say exactly: \"{closing}\"") })
            }
        }
    }

    async fn dispatch_gateway_tool(&mut self, tool_call_id: String, name: String, arguments: Map<String, Value>) -> Result<(), Value> {
        let rejected = |code: &str| json!({ "status": "REJECTED_BY_POLICY", "error_code": code });
        let tool = prompt::gateway_tools(&self.context.config, &self.context.snapshot.tools).into_iter().find(|tool| tool.name == name).cloned();
        let Some(tool) = tool else {
            return Err(rejected("TOOL_NOT_ALLOWED"));
        };
        let knowledge_query = if name == KNOWLEDGE_SEARCH_TOOL {
            let query: String = arguments.get("query").and_then(Value::as_str).map(str::trim).unwrap_or_default().chars().take(MAX_KNOWLEDGE_QUERY_CHARS).collect();
            if query.chars().count() < 2 {
                return Err(rejected("TOOL_SCHEMA_INVALID"));
            }
            Some(query)
        } else {
            None
        };
        let Some((specialist, budget)) =
            prompt::specialist_for_tool(&self.context.config, &name).map(|specialist| (specialist.kind.clone(), specialist.max_tool_executions))
        else {
            return Err(rejected("TOOL_NOT_ALLOWED"));
        };
        if self.in_flight.is_some() {
            return Err(json!({ "status": "REJECTED_BY_POLICY", "error_code": "TOOL_ALREADY_RUNNING", "retryable": true }));
        }
        if self.specialist_executions.get(&specialist).copied().unwrap_or(0) >= budget {
            return Err(rejected("TOOL_BUDGET_EXHAUSTED"));
        }
        let write = prompt::is_write(&tool);
        let confirmation = if write {
            let hash = action_hash(&name, &arguments);
            match (&self.pending, self.state) {
                (Some(pending), ConversationState::ToolExecution) if pending.tool_name == name && pending.arguments_hash == hash => self.confirmation.clone(),
                (Some(_), ConversationState::ToolExecution) => return Err(rejected("ARGUMENTS_DIFFER_FROM_CONFIRMATION")),
                _ => {
                    return Err(json!({
                        "status": "REJECTED_BY_POLICY",
                        "error_code": "CONFIRMATION_REQUIRED",
                        "instruction": "Call call_prepare_action and obtain the caller's confirmation first."
                    }));
                }
            }
        } else {
            if !READ_STATES.contains(&self.state) {
                return Err(rejected(if self.state == ConversationState::Greeting { "DISCLOSURE_PENDING" } else { "INVALID_STATE_TRANSITION" }));
            }
            None
        };
        if let GuardVerdict::Stop { reason } = self.cost_guard.try_start_tool_execution() {
            self.close_with_message(stop_reason_code(reason)).await;
            return Err(rejected("TOOL_BUDGET_EXHAUSTED"));
        }
        *self.specialist_executions.entry(specialist.clone()).or_insert(0) += 1;
        self.event(
            "call.tool_requested",
            json!({ "tool_name": name, "tool_call_id": tool_call_id, "specialist": specialist, "side_effect_class": tool.side_effect_class }),
        )
        .await;
        if let Some(query) = knowledge_query {
            self.spawn_knowledge_search(tool_call_id, query, Duration::from_millis(u64::from(tool.timeout_ms)));
            return Ok(());
        }
        let request = ToolExecutionRequest {
            tenant_id: self.context.tenant_id,
            call_id: Some(self.context.call_id),
            agent_version_id: self.context.snapshot.agent_version_id,
            specialist,
            tool_name: name.clone(),
            arguments,
            conversation_state: state_name(self.state),
            confirmation,
            verified_identity: self.identity_verified,
            trace_id: Some(self.context.trace_id.clone()),
        };
        let key = idempotency_key(self.context.call_id, &tool_call_id);
        let control = Arc::clone(&self.deps.control);
        let sender = self.tool_sender.clone();
        let tenant_id = self.context.tenant_id;
        let trace_id = self.context.trace_id.clone();
        let timeout = Duration::from_millis(u64::from(tool.timeout_ms)) + Duration::from_secs(2);
        self.in_flight = Some(ToolInFlight { call_id: tool_call_id.clone(), started: Instant::now(), filler_sent: false });
        tokio::spawn(async move {
            let started = Instant::now();
            let result = match tokio::time::timeout(timeout + Duration::from_secs(1), control.execute_tool(tenant_id, &key, &request, &trace_id, timeout)).await {
                Ok(Ok(response)) => Ok(response),
                Ok(Err(error)) => Err(error.code().map_or_else(|| "TOOL_GATEWAY_UNAVAILABLE".to_owned(), str::to_owned)),
                Err(_) => Err("TIMED_OUT".to_owned()),
            };
            let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let _ = sender.send(ToolCompletion { call_id: tool_call_id, tool_name: request.tool_name, write, result, latency_ms, embedding_tokens: 0 }).await;
        });
        Ok(())
    }

    fn spawn_knowledge_search(&mut self, tool_call_id: String, query: String, timeout: Duration) {
        let control = Arc::clone(&self.deps.control);
        let openai = Arc::clone(&self.deps.openai);
        let api_key = Arc::clone(&self.context.api_key);
        let sender = self.tool_sender.clone();
        let tenant_id = self.context.tenant_id;
        let trace_id = self.context.trace_id.clone();
        let body_language = Some(self.locale.as_str().to_owned());
        let location_id = self.context.routing.location_id;
        self.in_flight = Some(ToolInFlight { call_id: tool_call_id.clone(), started: Instant::now(), filler_sent: false });
        tokio::spawn(async move {
            let started = Instant::now();
            let embedded = tokio::time::timeout(EMBEDDING_TIMEOUT, openai.embed(&api_key, KNOWLEDGE_EMBEDDING_MODEL, KNOWLEDGE_EMBEDDING_DIMENSIONS, &query)).await;
            let (embedding, embedding_tokens) = match embedded {
                Ok(Ok(embedding)) => (Some(embedding.vector), embedding.tokens),
                Ok(Err(error)) => {
                    warn!(error = %error, "knowledge query embedding failed; falling back to lexical search");
                    (None, 0)
                }
                Err(_) => {
                    warn!("knowledge query embedding timed out; falling back to lexical search");
                    (None, 0)
                }
            };
            let body = KnowledgeSearchRequest { query, language: body_language, location_id, embedding, limit: KNOWLEDGE_RESULT_LIMIT };
            let result = match tokio::time::timeout(timeout + Duration::from_secs(1), control.search_knowledge(tenant_id, &body, &trace_id)).await {
                Ok(Ok(response)) => Ok(knowledge_tool_response(response)),
                Ok(Err(error)) => Err(error.code().map_or_else(|| "KNOWLEDGE_UNAVAILABLE".to_owned(), str::to_owned)),
                Err(_) => Err("TIMED_OUT".to_owned()),
            };
            let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let completion = ToolCompletion { call_id: tool_call_id, tool_name: KNOWLEDGE_SEARCH_TOOL.to_owned(), write: false, result, latency_ms, embedding_tokens };
            let _ = sender.send(completion).await;
        });
    }

    async fn on_tool_completion(&mut self, completion: ToolCompletion) {
        if completion.embedding_tokens > 0 {
            self.usage("backend_input_tokens", completion.embedding_tokens, "TOKENS", Some(KNOWLEDGE_EMBEDDING_MODEL.to_owned())).await;
        }
        if self.in_flight.as_ref().is_some_and(|in_flight| in_flight.call_id == completion.call_id) {
            self.in_flight = None;
        }
        self.deps.metrics.observe_ms("tool_latency", "tool", &completion.tool_name, completion.latency_ms);
        let (status, error_code, replayed, output) = match &completion.result {
            Ok(response) => {
                if response.result.get("identity_verified").and_then(Value::as_bool) == Some(true) {
                    self.identity_verified = true;
                    if self.state == ConversationState::Identity {
                        self.advance(ConversationEvent::IdentityVerified).await;
                    }
                }
                (
                    response.status.clone(),
                    response.error_code.clone(),
                    response.replayed,
                    json!({ "status": response.status, "result": response.result, "error_code": response.error_code, "retryable": response.retryable }),
                )
            }
            Err(code) => {
                let status = if code == "TIMED_OUT" { "TIMED_OUT" } else { "FAILED" };
                (status.to_owned(), Some(code.clone()), false, json!({ "status": status, "error_code": code, "retryable": true }))
            }
        };
        self.deps.metrics.increment("tool_runs", "status", &status);
        self.event(
            "call.tool_completed",
            json!({
                "tool_name": completion.tool_name,
                "tool_call_id": completion.call_id,
                "status": status,
                "error_code": error_code,
                "latency_ms": completion.latency_ms,
                "replayed": replayed,
            }),
        )
        .await;
        if completion.write {
            self.pending = None;
            self.confirmation = None;
            self.advance(ConversationEvent::ToolCompleted { success: status == "SUCCEEDED" }).await;
        }
        if self.finished {
            return;
        }
        self.tool_output(&completion.call_id, output).await;
    }

    async fn on_backend_usage(&mut self, model: Option<String>, input_tokens: u64, output_tokens: u64) {
        let model = model.unwrap_or_else(|| self.context.backend_model.clone());
        for (metric, quantity) in [("backend_input_tokens", input_tokens), ("backend_output_tokens", output_tokens)] {
            if quantity > 0 {
                self.usage(metric, quantity, "TOKENS", Some(model.clone())).await;
            }
        }
    }

    async fn usage(&mut self, metric: &str, quantity: u64, unit: &str, model: Option<String>) {
        self.deps
            .sink
            .usage(UsageRecord {
                source_event_id: Uuid::now_v7(),
                tenant_id: self.context.tenant_id,
                call_id: Some(self.context.call_id),
                metric: metric.to_owned(),
                quantity: i64::try_from(quantity).unwrap_or(i64::MAX),
                unit: unit.to_owned(),
                provider: Some("openai".to_owned()),
                model,
                occurred_at: crate::rfc3339(OffsetDateTime::now_utc()),
            })
            .await;
    }

    async fn on_usage(&mut self, seconds: f64) {
        let whole = if seconds.is_finite() && seconds > 0.0 { seconds.floor() as u64 } else { 0 };
        if whole <= self.reported_seconds {
            return;
        }
        let delta = whole - self.reported_seconds;
        self.reported_seconds = whole;
        let total_cost = whole.saturating_mul(self.deps.live_usd_micros_per_minute) / 60;
        let cost_delta = total_cost.saturating_sub(self.cost_usd_micros);
        self.cost_usd_micros = total_cost;
        let live_model = Some(self.deps.live_model.clone());
        self.usage("connected_voice_seconds", delta, "SECONDS", live_model.clone()).await;
        if cost_delta > 0 {
            self.usage("live_voice_cost", cost_delta, "USD_MICROS", live_model).await;
        }
        let verdict = self.cost_guard.record_spend(cost_delta);
        self.apply_verdict(verdict).await;
    }

    async fn apply_verdict(&mut self, verdict: GuardVerdict) {
        match verdict {
            GuardVerdict::Continue => {}
            GuardVerdict::WrapUp { reason } => {
                if !self.wrap_up_sent {
                    self.wrap_up_sent = true;
                    self.deps.metrics.increment("guard_wrap_ups", "reason", stop_reason_code(reason));
                    self.instruct(
                        "The call is about to reach its limit. Summarise what has been done, tell the caller how to follow up and close politely within one minute."
                            .to_owned(),
                    )
                    .await;
                }
            }
            GuardVerdict::Stop { reason } => {
                self.deps.metrics.increment("guard_stops", "reason", stop_reason_code(reason));
                self.close_with_message(stop_reason_code(reason)).await;
            }
        }
    }

    async fn on_dtmf(&mut self, digits: &str) {
        let now = Instant::now();
        let mut actions = Vec::new();
        if let Some(matcher) = self.dtmf.as_mut() {
            for character in digits.chars() {
                if let Ok(digit) = parse_digit(&character.to_string())
                    && let Some(action) = matcher.push(digit, now)
                {
                    actions.push(action);
                }
            }
        }
        for action in actions {
            self.on_dtmf_action(action).await;
        }
    }

    async fn on_dtmf_action(&mut self, action: DtmfAction) {
        match action {
            DtmfAction::HumanTransfer { destination_label } => {
                let handoff = &self.context.config.handoff;
                let label = destination_label.or_else(|| handoff.default_destination_label.clone());
                let destination = label
                    .and_then(|label| handoff.destinations.iter().find(|destination| destination.label == label))
                    .map(|destination| destination.e164.clone());
                let transfer_type = if handoff.warm_transfer { "WARM" } else { "COLD" };
                match destination {
                    Some(destination) => {
                        if let Err(code) = self.start_transfer(&destination, transfer_type, "caller pressed the transfer key", "caller_dtmf", None).await {
                            warn!(call_id = %self.context.call_id, code, "DTMF transfer rejected");
                        }
                    }
                    None => self.instruct("The caller asked for a human but no transfer destination is configured. Apologise and offer to take a message.".to_owned()).await,
                }
            }
            DtmfAction::Back => self.instruct("The caller pressed the key to go back. Return to the previous question.".to_owned()).await,
            DtmfAction::RepeatMenu => self.instruct("The caller asked to hear the options again. Briefly repeat what you can help with.".to_owned()).await,
        }
    }

    async fn start_transfer(
        &mut self,
        destination_e164: &str,
        transfer_type: &str,
        reason: &str,
        requested_by: &str,
        attempt_id: Option<Uuid>,
    ) -> Result<Uuid, &'static str> {
        if self.transfer.is_some() {
            return Err("CONFLICT");
        }
        if self.closing.is_some() {
            return Err("INVALID_STATE_TRANSITION");
        }
        if !matches!(transfer_type, "COLD" | "WARM") {
            return Err("VALIDATION_FAILED");
        }
        if !self.context.config.handoff.destinations.iter().any(|destination| destination.e164 == destination_e164) {
            return Err("TRANSFER_DESTINATION_NOT_ALLOWED");
        }
        let attempt_id = attempt_id.unwrap_or_else(Uuid::now_v7);
        self.flush_segment().await;
        self.advance(ConversationEvent::HandoffRequested).await;
        let delay = if transfer_type == "WARM" { self.deps.timing.warm_transfer_delay } else { Duration::ZERO };
        if transfer_type == "WARM" {
            self.instruct("Tell the caller in one short sentence that you are transferring them to a colleague now.".to_owned()).await;
        }
        self.transfer = Some(TransferState { attempt_id, destination_e164: destination_e164.to_owned(), refer_at: Instant::now() + delay, referred: false });
        self.event(
            "call.transfer_state_changed",
            json!({
                "transfer_attempt_id": attempt_id,
                "state": "REQUESTED",
                "transfer_type": transfer_type,
                "requested_by": requested_by,
                "reason": reason.chars().take(200).collect::<String>(),
                "destination": redact_e164(destination_e164),
            }),
        )
        .await;
        Ok(attempt_id)
    }

    async fn perform_refer(&mut self) {
        let Some((attempt_id, destination)) =
            self.transfer.as_ref().filter(|transfer| !transfer.referred).map(|transfer| (transfer.attempt_id, transfer.destination_e164.clone()))
        else {
            return;
        };
        match self.deps.openai.refer(&self.context.api_key, &self.context.session_id, &format!("tel:{destination}")).await {
            Ok(()) => {
                if let Some(transfer) = self.transfer.as_mut() {
                    transfer.referred = true;
                }
                self.deps.metrics.increment("transfers", "result", "referred");
                self.event("call.transfer_state_changed", json!({ "transfer_attempt_id": attempt_id, "state": "REFERRED" })).await;
                let control = Arc::clone(&self.deps.control);
                let mut body = base_upsert(&self.context, &self.deps.instance_id, "TRANSFERRING");
                body.answered_at = Some(crate::rfc3339(self.answered_at));
                body.conversation_state = Some(state_name(self.state));
                let (tenant_id, call_id, trace_id) = (self.context.tenant_id, self.context.call_id, self.context.trace_id.clone());
                tokio::spawn(async move {
                    if let Err(error) = control.upsert_call(tenant_id, call_id, &body, &trace_id).await {
                        warn!(error = %error, %call_id, "transferring status update failed");
                    }
                });
            }
            Err(error) => {
                warn!(error = %error, call_id = %self.context.call_id, "SIP refer failed");
                self.deps.metrics.increment("transfers", "result", "failed");
                self.transfer = None;
                self.event(
                    "call.transfer_state_changed",
                    json!({ "transfer_attempt_id": attempt_id, "state": "FAILED", "error_code": "PROVIDER_ERROR" }),
                )
                .await;
                self.advance(ConversationEvent::FurtherRequest).await;
                let instruction = match self.context.config.handoff.no_answer_behavior.as_str() {
                    "CALLBACK_REQUEST" => "The transfer could not be completed. Apologise and offer to arrange a callback; ask for a preferred time.",
                    "ALTERNATE_QUEUE" => "The transfer could not be completed. Apologise and offer to take a message for the team.",
                    _ => "The transfer could not be completed. Apologise briefly and continue helping the caller yourself.",
                };
                self.instruct(instruction.to_owned()).await;
            }
        }
    }

    async fn on_command(&mut self, command: SessionCommand) {
        match command {
            SessionCommand::Runtime { command, reply } => {
                let result = match command {
                    RuntimeCommand::Transfer { call_id, transfer_attempt_id, destination_e164, transfer_type, reason, requested_by }
                        if call_id == self.context.call_id =>
                    {
                        match self.start_transfer(&destination_e164, &transfer_type, &reason, &requested_by, Some(transfer_attempt_id)).await {
                            Ok(_) => RuntimeCommandReply { accepted: true, state: "TRANSFER_REQUESTED".into(), error_code: None },
                            Err(code) => RuntimeCommandReply { accepted: false, state: state_name(self.state), error_code: Some(code.into()) },
                        }
                    }
                    RuntimeCommand::Terminate { call_id, .. } if call_id == self.context.call_id => {
                        if self.closing.is_some() {
                            RuntimeCommandReply { accepted: false, state: "ENDING".into(), error_code: Some("INVALID_STATE_TRANSITION".into()) }
                        } else {
                            let closing = self.closing_sentence();
                            self.instruct(format!("An operator ended this call. Say exactly: \"{closing}\"")).await;
                            self.request_close("OPERATOR_TERMINATED", Duration::from_secs(3));
                            RuntimeCommandReply { accepted: true, state: "TERMINATING".into(), error_code: None }
                        }
                    }
                    _ => RuntimeCommandReply { accepted: false, state: state_name(self.state), error_code: Some("VALIDATION_FAILED".into()) },
                };
                let _ = reply.send(result);
            }
            SessionCommand::Shutdown { reason } => {
                let code = match reason {
                    ShutdownReason::DrainTimeout => "RUNTIME_FAILURE",
                    ShutdownReason::KillSwitch => "KILL_SWITCH",
                };
                self.close_with_message(code).await;
            }
        }
    }

    async fn on_tick(&mut self) {
        let now = Instant::now();
        if self.buffer.as_ref().is_some_and(|buffer| now.duration_since(buffer.last_delta) >= self.deps.timing.segment_idle) {
            self.flush_segment().await;
        }
        if let Some(action) = self.dtmf.as_mut().and_then(|matcher| matcher.flush_on_timeout(now)) {
            self.on_dtmf_action(action).await;
        }
        if self.in_flight.as_ref().is_some_and(|in_flight| !in_flight.filler_sent && now.duration_since(in_flight.started) >= self.deps.timing.filler_after) {
            if let Some(in_flight) = self.in_flight.as_mut() {
                in_flight.filler_sent = true;
            }
            if let Some(filler) = prompt::filler_text(self.locale) {
                self.send(ClientEvent::CommentaryAppend { content: filler.to_owned(), delegation_id: None, event_id: client_event_id() }).await;
            }
        }
        if self.transfer.as_ref().is_some_and(|transfer| !transfer.referred && transfer.refer_at <= now) {
            self.perform_refer().await;
        }
        if self.state == ConversationState::Greeting && !self.disclosure_reminded && now.duration_since(self.answered) >= self.deps.timing.disclosure_reminder_after {
            self.disclosure_reminded = true;
            let locale = self.locale;
            if let Some(disclosure) = prompt::configured_disclosure(&self.context.config, locale).map(str::to_owned) {
                self.instruct(format!("Before anything else say exactly: \"{disclosure}\"")).await;
            } else if let Some(disclosure) = prompt::disclosure_text(&self.context.config, locale).map(str::to_owned) {
                self.instruct(format!("Before anything else say in {} the faithful equivalent of: \"{disclosure}\"", prompt::language_name(locale))).await;
            }
        }
        let verdict = self.cost_guard.check_elapsed(now.duration_since(self.answered));
        self.apply_verdict(verdict).await;
        let silence = Duration::from_secs(self.context.config.limits.silence_timeout_seconds);
        if self.closing.is_none() && self.in_flight.is_none() && self.buffer.is_none() && self.transfer.is_none() && now.duration_since(self.last_activity) >= silence {
            if self.silence_prompted {
                self.close_with_message("SILENCE_TIMEOUT").await;
            } else {
                self.silence_prompted = true;
                self.last_activity = now;
                self.instruct("The caller has been silent. Ask briefly whether they are still on the line.".to_owned()).await;
            }
        }
        if now.duration_since(self.last_heartbeat) >= self.context.admission.lease / 3 {
            self.last_heartbeat = now;
            let gate = Arc::clone(&self.deps.gate);
            let request = self.context.admission.clone();
            tokio::spawn(async move { gate.heartbeat(&request).await });
        }
        if let Some(closing) = self.closing.filter(|closing| closing.deadline <= now) {
            if closing.hangup_sent {
                self.finalize(None).await;
            } else {
                if let Err(error) = self.deps.openai.hangup(&self.context.api_key, &self.context.session_id).await {
                    warn!(error = %error, call_id = %self.context.call_id, "hangup request failed; closing the sideband session");
                    self.send(ClientEvent::SessionClose { event_id: client_event_id() }).await;
                }
                self.closing = Some(Closing { hangup_sent: true, deadline: now + self.deps.timing.close_timeout, ..closing });
            }
        }
    }

    async fn finalize(&mut self, closed_reason: Option<String>) {
        if self.finished {
            return;
        }
        self.flush_segment().await;
        let transferred = self.transfer.as_ref().is_some_and(|transfer| transfer.referred);
        let end_reason = match (closed_reason.as_deref(), self.closing) {
            _ if transferred => "TRANSFER_COMPLETED",
            (_, Some(closing)) => closing.reason,
            (Some("remote_hangup"), None) => "CALLER_HANGUP",
            (Some("expired"), None) => "MAX_DURATION_REACHED",
            (Some("content"), None) => "POLICY_VIOLATION",
            (Some("connection_lost"), None) => {
                self.failure = true;
                "PROVIDER_FAILURE"
            }
            (Some(_), None) => "AGENT_HANGUP",
            (None, None) => {
                self.failure = true;
                "RUNTIME_FAILURE"
            }
        };
        let status = if transferred {
            "TRANSFERRED"
        } else if self.failure {
            "FAILED"
        } else {
            "COMPLETED"
        };
        let connected_seconds = self.reported_seconds.max(self.answered.elapsed().as_secs().min(self.reported_seconds.max(1)));
        let outcome = self.outcome.clone().unwrap_or_else(|| {
            if transferred {
                "TRANSFERRED_TO_HUMAN".to_owned()
            } else if self.state == ConversationState::Greeting && end_reason == "CALLER_HANGUP" {
                "ABANDONED".to_owned()
            } else if self.failure {
                "FAILED".to_owned()
            } else {
                "UNRESOLVED".to_owned()
            }
        });
        self.advance(ConversationEvent::Hangup).await;
        self.event(
            "call.ended",
            json!({
                "end_reason": end_reason,
                "status": status,
                "outcome": outcome,
                "connected_seconds": connected_seconds,
                "cost_usd_micros": self.cost_usd_micros,
                "tool_executions": self.cost_guard.tool_executions(),
            }),
        )
        .await;
        let mut body = base_upsert(&self.context, &self.deps.instance_id, status);
        body.answered_at = Some(crate::rfc3339(self.answered_at));
        body.ended_at = Some(crate::rfc3339(OffsetDateTime::now_utc()));
        body.conversation_state = Some(state_name(self.state));
        body.intent = self.intent.clone();
        body.outcome = Some(outcome);
        body.end_reason = Some(end_reason.to_owned());
        body.connected_seconds = Some(connected_seconds);
        body.billable_seconds = Some(connected_seconds);
        body.cost_usd_micros = Some(self.cost_usd_micros);
        if let Err(error) = self.deps.control.upsert_call(self.context.tenant_id, self.context.call_id, &body, &self.context.trace_id).await {
            error!(error = %error, call_id = %self.context.call_id, "final call state could not be recorded; reconciliation will close the call");
            self.deps.metrics.increment("control_api_errors", "operation", "final_upsert");
        }
        if !self.deps.sink.flush(Duration::from_secs(10)).await {
            self.deps.metrics.increment("call_data_undelivered", "call_phase", "final_flush");
        }
        self.deps.gate.release(&self.context.admission).await;
        self.deps.registry.remove(self.context.call_id);
        self.deps.metrics.add_active_calls(-1);
        self.deps.metrics.increment("calls_ended", "end_reason", end_reason);
        info!(call_id = %self.context.call_id, end_reason, status, connected_seconds, "call session finished");
        self.finished = true;
    }
}

#[cfg(test)]
mod tests;
