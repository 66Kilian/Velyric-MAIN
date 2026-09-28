use std::error::Error;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use url::Url;
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

use super::*;
use crate::admission::AdmissionLimits;
use crate::config::Environment;
use crate::events::{self, SinkContext};
use crate::registry::SessionHandle;
use crate::test_support::{TestKeys, agent_snapshot, routing_snapshot};

type TestResult = Result<(), Box<dyn Error>>;
type ScriptResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const TRACE: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const GREETING: &str = "Jó napot, a Demo Rendelő asszisztense vagyok. Mesterséges intelligencia alapú asszisztens vagyok, a hívás minőségbiztosítási célból feldolgozásra kerül.";

#[test]
fn disclosure_detection_tolerates_punctuation_case_and_extra_words() {
    let expected = "Mesterséges intelligencia alapú asszisztens vagyok, a hívás minőségbiztosítási célból feldolgozásra kerül.";
    assert!(disclosure_delivered(
        expected,
        "Jó napot! MESTERSÉGES intelligencia alapú asszisztens vagyok és a hívás minőségbiztosítási célból feldolgozásra kerül"
    ));
    assert!(!disclosure_delivered(expected, "Jó napot, miben segíthetek?"));
    assert!(disclosure_delivered("", "anything"));
}

#[test]
fn action_hashes_ignore_key_order_and_idempotency_keys_are_sanitized() -> TestResult {
    let first: Map<String, Value> = serde_json::from_str(r#"{"slot_id":"s1","name":"Kiss Anna"}"#)?;
    let second: Map<String, Value> = serde_json::from_str(r#"{"name":"Kiss Anna","slot_id":"s1"}"#)?;
    assert_eq!(action_hash("create_booking", &first), action_hash("create_booking", &second));
    assert_ne!(action_hash("create_booking", &first), action_hash("cancel_booking", &first));
    let call = Uuid::from_u128(1);
    assert_eq!(idempotency_key(call, "call_ab/c d"), format!("{call}:call_ab_c_d"));
    Ok(())
}

struct Gateway;

impl Respond for Gateway {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let result = match body.get("tool_name").and_then(Value::as_str) {
            Some("create_booking") => json!({ "booking_id": "bk_1" }),
            _ => json!({ "slots": [{ "slot_id": "s1", "start": "2026-09-15T09:00:00+02:00" }] }),
        };
        ResponseTemplate::new(200).set_body_json(json!({
            "tool_run_id": Uuid::now_v7(), "status": "SUCCEEDED", "result": result, "error_code": null, "retryable": false, "replayed": false
        }))
    }
}

struct Rig {
    server: MockServer,
    control: Arc<ControlApiClient>,
    openai: Arc<OpenAiLiveClient>,
    metrics: Arc<Metrics>,
    registry: Arc<Registry>,
    gate: Arc<AdmissionGate>,
    tenant: Uuid,
    version: Uuid,
    call_id: Uuid,
}

async fn rig(seed: u8) -> Result<Rig, Box<dyn Error>> {
    crate::install_crypto_provider();
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/internal/v1/tool-gateway/executions")).respond_with(Gateway).mount(&server).await;
    Mock::given(method("POST"))
        .and(path_regex("^/internal/v1/calls/[0-9a-f-]+/events$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path_regex("^/internal/v1/calls/[0-9a-f-]+$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(&server)
        .await;
    let keys = TestKeys::new(seed)?;
    Ok(Rig {
        control: Arc::new(ControlApiClient::new(
            reqwest::Client::builder().build()?,
            Url::parse(&server.uri())?,
            Arc::new(keys.signer("voice-runtime")?),
            None,
            "ci",
        )),
        openai: Arc::new(OpenAiLiveClient::new(reqwest::Client::builder().build()?, Url::parse(&format!("{}/v1", server.uri()))?)?),
        metrics: Arc::new(Metrics::new(crate::METRICS_PREFIX)),
        registry: Arc::new(Registry::default()),
        gate: Arc::new(AdmissionGate::new(
            None,
            Environment::Ci,
            "eu-central-1",
            AdmissionLimits { global_max_calls: 10, provider_max_calls: 10, fallback_max_calls_per_tenant: 4, lease: Duration::from_secs(30) },
        )),
        server,
        tenant: Uuid::now_v7(),
        version: Uuid::now_v7(),
        call_id: Uuid::now_v7(),
    })
}

async fn launch(rig: &Rig, session_id: &str, stream: SidebandStream) -> Result<(JoinHandle<()>, mpsc::Sender<SessionCommand>), Box<dyn Error>> {
    let routing = Arc::new(routing_snapshot(rig.tenant, rig.version));
    let admission = rig.gate.request(rig.call_id, &routing, "openai")?;
    rig.gate.acquire(&admission, &rig.metrics).await?;
    let snapshot = Arc::new(agent_snapshot(rig.tenant, rig.version));
    let config: AgentConfig = serde_json::from_value(snapshot.config.clone())?;
    let (sink, sink_task) = events::spawn(SinkContext {
        control: Arc::clone(&rig.control),
        jetstream: None,
        metrics: Arc::clone(&rig.metrics),
        tenant_id: rig.tenant,
        call_id: rig.call_id,
        trace_id: TRACE.into(),
    });
    let (commands, receiver) = mpsc::channel(8);
    rig.registry.insert(rig.call_id, SessionHandle { tenant_id: rig.tenant, commands: commands.clone() });
    let context = SessionContext {
        call_id: rig.call_id,
        tenant_id: rig.tenant,
        trace_id: TRACE.into(),
        session_id: session_id.into(),
        routing,
        snapshot,
        config,
        locale: Locale::HU,
        language_source: LanguageSource::TenantDefault,
        caller_e164: Some("+36301234567".into()),
        api_key: Arc::new(SecretString::from("sk-test".to_owned())),
        admission,
        admission_degraded: false,
        started_at: OffsetDateTime::now_utc(),
        backend_model: "gpt-5.6-luna".into(),
    };
    let deps = SessionDeps {
        control: Arc::clone(&rig.control),
        openai: Arc::clone(&rig.openai),
        gate: Arc::clone(&rig.gate),
        registry: Arc::clone(&rig.registry),
        metrics: Arc::clone(&rig.metrics),
        sink,
        timing: SessionTiming::default(),
        live_usd_micros_per_minute: 50_000,
        live_model: "gpt-live-1".into(),
        instance_id: "rt-test".into(),
    };
    let handle = tokio::spawn(async move {
        run(context, deps, stream, receiver).await;
        let _ = sink_task.await;
    });
    Ok((handle, commands))
}

async fn sideband_pair() -> Result<(JoinHandle<ScriptResult<WebSocketStream<TcpStream>>>, SidebandStream), Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await?;
        Ok(tokio_tungstenite::accept_async(tcp).await?)
    });
    let (client, _) = tokio_tungstenite::connect_async(format!("ws://{address}/v1/live/sessions/sess/attach")).await?;
    Ok((server, client))
}

fn text(value: Value) -> Message {
    Message::Text(value.to_string().into())
}

fn transcript(kind: &str, delta: &str, start: u64, end: u64) -> Message {
    text(json!({ "type": format!("session.{kind}_transcript.delta"), "event_id": "evt", "delta": delta, "start_ms": start, "end_ms": end }))
}

fn function_call(call_id: &str, name: &str, arguments: Value) -> Message {
    text(json!({
        "type": "response.event",
        "event_id": "evt",
        "delegation_id": null,
        "event": { "type": "response.output_item.done", "item": { "type": "function_call", "call_id": call_id, "name": name, "arguments": arguments.to_string() } }
    }))
}

async fn tool_output(ws: &mut WebSocketStream<TcpStream>) -> ScriptResult<Value> {
    let mut output = None;
    loop {
        let message = tokio::time::timeout(Duration::from_secs(10), ws.next()).await?.ok_or("sideband closed")??;
        let Message::Text(raw) = message else {
            continue;
        };
        let event: Value = serde_json::from_str(raw.as_str())?;
        match event.get("type").and_then(Value::as_str) {
            Some("response.item.create") => {
                let encoded = event.pointer("/item/output").and_then(Value::as_str).ok_or("missing output")?;
                output = Some(serde_json::from_str::<Value>(encoded)?);
            }
            Some("response.create") => return output.ok_or_else(|| "response.create without output".into()),
            _ => {}
        }
    }
}

async fn requests_matching(server: &MockServer, verb: &str, suffix: &str) -> Result<Vec<Value>, Box<dyn Error>> {
    let requests = server.received_requests().await.ok_or("request recording disabled")?;
    Ok(requests
        .iter()
        .filter(|request| request.method.as_str() == verb && request.url.path().ends_with(suffix))
        .filter_map(|request| serde_json::from_slice::<Value>(&request.body).ok())
        .collect())
}

#[tokio::test]
async fn booking_requires_disclosure_preview_and_a_spoken_confirmation_before_the_write() -> TestResult {
    let rig = rig(21).await?;
    let (server, client) = sideband_pair().await?;
    let script = tokio::spawn(async move {
        let mut ws = server.await??;
        let mut outputs = Vec::new();
        ws.send(transcript("output", GREETING, 0, 6_000)).await?;
        ws.send(transcript("input", "Holnap délelőtt szeretnék időpontot.", 6_500, 8_000)).await?;
        ws.send(function_call("call_1", "lookup_availability", json!({ "date": "2026-09-15" }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(function_call("call_2", "create_booking", json!({ "slot_id": "s1", "name": "Kiss Anna" }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(function_call(
            "call_3",
            "call_prepare_action",
            json!({ "tool_name": "create_booking", "arguments": { "slot_id": "s1", "name": "Kiss Anna" }, "summary": "Holnap 9:00, Kiss Anna" }),
        ))
        .await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(function_call("call_4", "call_confirm_action", json!({ "confirmed": true }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(transcript("output", "Holnap kilenc órára foglalhatok Kiss Anna nevére. Megerősíti?", 9_000, 12_000)).await?;
        ws.send(transcript("input", "Igen, kérem.", 12_500, 13_200)).await?;
        ws.send(function_call("call_5", "call_confirm_action", json!({ "confirmed": true }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(function_call("call_6", "create_booking", json!({ "slot_id": "s1", "name": "Kiss Anne" }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(function_call("call_7", "create_booking", json!({ "name": "Kiss Anna", "slot_id": "s1" }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(text(json!({ "type": "session.usage.updated", "event_id": "evt", "usage": { "seconds": 42.4 } }))).await?;
        ws.send(function_call("call_8", "call_end", json!({ "outcome": "BOOKING_CREATED", "reason": "booked" }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(text(json!({ "type": "session.closed", "event_id": "evt", "reason": "remote_hangup", "session": { "id": "sess_1" }, "usage": { "seconds": 42.9 } })))
            .await?;
        ScriptResult::Ok(outputs)
    });
    let (session, _commands) = launch(&rig, "sess_1", client).await?;
    tokio::time::timeout(Duration::from_secs(30), session).await??;
    let outputs = script.await?.map_err(|error| error.to_string())?;
    let codes: Vec<&str> = outputs
        .iter()
        .map(|output| output.get("error_code").and_then(Value::as_str).or_else(|| output.get("status").and_then(Value::as_str)).unwrap_or_default())
        .collect();
    assert_eq!(
        codes,
        vec![
            "SUCCEEDED",
            "CONFIRMATION_REQUIRED",
            "AWAITING_CALLER_CONFIRMATION",
            "CALLER_ANSWER_REQUIRED",
            "CONFIRMED",
            "ARGUMENTS_DIFFER_FROM_CONFIRMATION",
            "SUCCEEDED",
            "ENDING"
        ]
    );
    let executions = requests_matching(&rig.server, "POST", "/tool-gateway/executions").await?;
    assert_eq!(executions.len(), 2);
    assert_eq!(executions.first().and_then(|body| body.get("conversation_state")), Some(&json!("DISCOVERY")));
    let booking = executions.get(1).ok_or("missing booking execution")?;
    assert_eq!(booking.get("conversation_state"), Some(&json!("TOOL_EXECUTION")));
    assert_eq!(booking.pointer("/confirmation/confirmation_turn_seq"), Some(&json!(4)));
    assert_eq!(booking.get("specialist"), Some(&json!("BOOKING")));
    let finals = requests_matching(&rig.server, "PUT", &rig.call_id.to_string()).await?;
    let last = finals.last().ok_or("missing final call upsert")?;
    assert_eq!(last.get("status"), Some(&json!("COMPLETED")));
    assert_eq!(last.get("end_reason"), Some(&json!("AGENT_HANGUP")));
    assert_eq!(last.get("outcome"), Some(&json!("BOOKING_CREATED")));
    assert_eq!(last.get("connected_seconds"), Some(&json!(42)));
    assert_eq!(last.get("cost_usd_micros"), Some(&json!(35_000)));
    assert_eq!(last.get("conversation_state"), Some(&json!("END")));
    let batches = requests_matching(&rig.server, "POST", "/events").await?;
    let event_types: Vec<String> = batches
        .iter()
        .flat_map(|batch| batch.get("events").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter_map(|event| event.get("event_type").and_then(Value::as_str).map(str::to_owned))
        .collect();
    for expected in ["call.admission_decided", "call.started", "call.disclosure_delivered", "call.tool_requested", "call.tool_completed", "call.ended"] {
        assert!(event_types.iter().any(|event_type| event_type == expected), "missing {expected} in {event_types:?}");
    }
    let segments: Vec<Value> =
        batches.iter().flat_map(|batch| batch.get("transcript").and_then(Value::as_array).cloned().unwrap_or_default()).collect();
    assert_eq!(segments.len(), 4);
    assert!(rig.registry.is_empty());
    assert_eq!(rig.metrics.active_calls(), 0);
    Ok(())
}

#[tokio::test]
async fn operator_transfers_are_allowlisted_referred_and_recorded_as_transferred() -> TestResult {
    let rig = rig(22).await?;
    Mock::given(method("POST"))
        .and(path("/v1/live/sessions/sess_2/refer"))
        .and(wiremock::matchers::body_json(json!({ "target_uri": "tel:+3612345678" })))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&rig.server)
        .await;
    let (server, client) = sideband_pair().await?;
    let (referred_sender, referred_receiver) = oneshot::channel::<()>();
    let script = tokio::spawn(async move {
        let mut ws = server.await??;
        ws.send(transcript("output", GREETING, 0, 6_000)).await?;
        ws.send(transcript("input", "Kérem kapcsoljon a recepcióra.", 6_500, 8_000)).await?;
        tokio::time::timeout(Duration::from_secs(10), referred_receiver).await??;
        ws.send(text(json!({ "type": "session.closed", "event_id": "evt", "reason": "remote_hangup", "session": { "id": "sess_2" }, "usage": { "seconds": 20.0 } })))
            .await?;
        ScriptResult::Ok(())
    });
    let (session, commands) = launch(&rig, "sess_2", client).await?;
    let (reply, rejected) = oneshot::channel();
    commands
        .send(SessionCommand::Runtime {
            command: RuntimeCommand::Transfer {
                call_id: rig.call_id,
                transfer_attempt_id: Uuid::now_v7(),
                destination_e164: "+3699999999".into(),
                transfer_type: "COLD".into(),
                reason: "operator".into(),
                requested_by: "user-1".into(),
            },
            reply,
        })
        .await?;
    let rejected = rejected.await?;
    assert!(!rejected.accepted);
    assert_eq!(rejected.error_code.as_deref(), Some("TRANSFER_DESTINATION_NOT_ALLOWED"));
    let (reply, accepted) = oneshot::channel();
    commands
        .send(SessionCommand::Runtime {
            command: RuntimeCommand::Transfer {
                call_id: rig.call_id,
                transfer_attempt_id: Uuid::now_v7(),
                destination_e164: "+3612345678".into(),
                transfer_type: "COLD".into(),
                reason: "operator".into(),
                requested_by: "user-1".into(),
            },
            reply,
        })
        .await?;
    assert!(accepted.await?.accepted);
    for _ in 0..40 {
        let refers = rig.server.received_requests().await.unwrap_or_default().iter().filter(|request| request.url.path().ends_with("/refer")).count();
        if refers > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = referred_sender.send(());
    tokio::time::timeout(Duration::from_secs(30), session).await??;
    script.await?.map_err(|error| error.to_string())?;
    let finals = requests_matching(&rig.server, "PUT", &rig.call_id.to_string()).await?;
    let statuses: Vec<&str> = finals.iter().filter_map(|body| body.get("status").and_then(Value::as_str)).collect();
    assert!(statuses.contains(&"TRANSFERRING"), "{statuses:?}");
    let last = finals.iter().rev().find(|body| body.get("ended_at").is_some()).ok_or("missing final upsert")?;
    assert_eq!(last.get("status"), Some(&json!("TRANSFERRED")));
    assert_eq!(last.get("end_reason"), Some(&json!("TRANSFER_COMPLETED")));
    assert_eq!(last.get("outcome"), Some(&json!("TRANSFERRED_TO_HUMAN")));
    Ok(())
}

#[tokio::test]
async fn knowledge_questions_are_answered_from_embedded_hybrid_search_results() -> TestResult {
    let rig = rig(23).await?;
    let vector: Vec<f32> = (0..1536).map(|index| if index == 0 { 1.0 } else { 0.0 }).collect();
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": [{ "index": 0, "embedding": vector }], "usage": { "prompt_tokens": 6, "total_tokens": 6 } })))
        .mount(&rig.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/internal/v1/knowledge/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "mode": "HYBRID",
            "results": [{
                "chunk_id": Uuid::now_v7(),
                "source_id": Uuid::now_v7(),
                "source_title": "Házirend",
                "source_type": "FILE_PDF",
                "content": "Az udvarban ingyenes a parkolás.",
                "heading_path": ["Parkolás"],
                "language": "hu",
                "freshness": "FRESH",
                "last_synced_at": "2026-09-14T08:00:00.000Z",
                "score": 0.0325
            }]
        })))
        .mount(&rig.server)
        .await;
    let (server, client) = sideband_pair().await?;
    let script = tokio::spawn(async move {
        let mut ws = server.await??;
        let mut outputs = Vec::new();
        ws.send(function_call("call_0", "search_knowledge", json!({ "query": "Van parkoló?" }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(transcript("output", GREETING, 0, 6_000)).await?;
        ws.send(transcript("input", "Van parkolóhely a rendelőnél?", 6_500, 8_000)).await?;
        ws.send(function_call("call_1", "search_knowledge", json!({ "query": "x" }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(function_call("call_2", "search_knowledge", json!({ "query": "  Van parkoló a rendelőnél?  " }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(function_call("call_3", "call_end", json!({ "outcome": "INFORMATION_PROVIDED", "reason": "answered" }))).await?;
        outputs.push(tool_output(&mut ws).await?);
        ws.send(text(json!({ "type": "session.closed", "event_id": "evt", "reason": "remote_hangup", "session": { "id": "sess_k" }, "usage": { "seconds": 20.0 } }))).await?;
        ScriptResult::Ok(outputs)
    });
    let (session, _commands) = launch(&rig, "sess_k", client).await?;
    tokio::time::timeout(Duration::from_secs(30), session).await??;
    let outputs = script.await?.map_err(|error| error.to_string())?;
    assert_eq!(outputs.first().and_then(|output| output.get("error_code")), Some(&json!("DISCLOSURE_PENDING")));
    assert_eq!(outputs.get(1).and_then(|output| output.get("error_code")), Some(&json!("TOOL_SCHEMA_INVALID")));
    let answer = outputs.get(2).ok_or("missing knowledge output")?;
    assert_eq!(answer.get("status"), Some(&json!("SUCCEEDED")));
    assert_eq!(answer.pointer("/result/mode"), Some(&json!("HYBRID")));
    assert_eq!(answer.pointer("/result/results/0/content"), Some(&json!("Az udvarban ingyenes a parkolás.")));
    assert_eq!(answer.pointer("/result/results/0/section"), Some(&json!("Parkolás")));
    let searches = requests_matching(&rig.server, "POST", "/internal/v1/knowledge/search").await?;
    assert_eq!(searches.len(), 1);
    let search = searches.first().ok_or("missing search request")?;
    assert_eq!(search.get("query"), Some(&json!("Van parkoló a rendelőnél?")));
    assert_eq!(search.get("language"), Some(&json!("hu")));
    assert_eq!(search.get("limit"), Some(&json!(4)));
    assert_eq!(search.get("embedding").and_then(Value::as_array).map(Vec::len), Some(1536));
    let embeddings = requests_matching(&rig.server, "POST", "/v1/embeddings").await?;
    assert_eq!(embeddings.first().and_then(|body| body.get("model")), Some(&json!("text-embedding-3-small")));
    assert_eq!(requests_matching(&rig.server, "POST", "/tool-gateway/executions").await?.len(), 0);
    Ok(())
}
