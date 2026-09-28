use std::error::Error;
use std::sync::Mutex;

use futures_util::SinkExt;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request as HandshakeRequest, Response as HandshakeResponse};
use wiremock::matchers::{body_json, method, path, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;
use crate::sip::SipHeader;
use crate::test_support::{agent_snapshot, routing_snapshot, runtime_state};

type TestResult = Result<(), Box<dyn Error>>;

fn incoming(session_id: &str) -> IncomingCallData {
    IncomingCallData {
        session_id: session_id.into(),
        sip_headers: vec![
            SipHeader { name: "From".into(), value: "<sip:+36301234567@sip.telnyx.com>;tag=abc".into() },
            SipHeader { name: "To".into(), value: "<sip:+3612345678@proj_1.sip.api.openai.com>".into() },
            SipHeader { name: "Call-ID".into(), value: "a84b4c76e66710@pc33".into() },
        ],
    }
}

async fn mount_control(server: &MockServer, routing: &RoutingSnapshot, snapshot: &AgentSnapshot) {
    Mock::given(method("GET"))
        .and(path("/internal/v1/runtime/routing"))
        .and(query_param("provider", "telnyx"))
        .and(query_param("e164", "+3612345678"))
        .respond_with(ResponseTemplate::new(200).set_body_json(routing))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/internal/v1/runtime/tenants/{}/openai-credentials", routing.tenant_id)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "tenant_id": routing.tenant_id, "api_key": null, "webhook_secret": null })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/internal/v1/runtime/agent-snapshots/{}", snapshot.agent_version_id)))
        .respond_with(ResponseTemplate::new(200).set_body_json(snapshot))
        .mount(server)
        .await;
    Mock::given(method("PUT")).and(path_regex("^/internal/v1/calls/[0-9a-f-]+$")).respond_with(ResponseTemplate::new(200).set_body_json(json!({}))).mount(server).await;
    Mock::given(method("POST"))
        .and(path_regex("^/internal/v1/calls/[0-9a-f-]+/events$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(server)
        .await;
}

async fn bodies(server: &MockServer, verb: &str, pattern: &str) -> Result<Vec<Value>, Box<dyn Error>> {
    let requests = server.received_requests().await.ok_or("request recording disabled")?;
    Ok(requests
        .iter()
        .filter(|request| request.method.as_str() == verb && request.url.path().contains(pattern))
        .filter_map(|request| serde_json::from_slice(&request.body).ok())
        .collect())
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn admitted_calls_are_accepted_attached_and_run_to_completion() -> TestResult {
    let server = MockServer::start().await;
    let tenant = Uuid::now_v7();
    let version = Uuid::now_v7();
    let routing = routing_snapshot(tenant, version);
    let snapshot = agent_snapshot(tenant, version);
    mount_control(&server, &routing, &snapshot).await;
    Mock::given(method("POST")).and(path("/v1/live/sessions/sess_in/accept")).respond_with(ResponseTemplate::new(200)).expect(1).mount(&server).await;

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let captured: Arc<Mutex<Option<(String, String)>>> = Arc::new(Mutex::new(None));
    let capture = Arc::clone(&captured);
    let sideband = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await?;
        let callback = move |request: &HandshakeRequest, response: HandshakeResponse| {
            let authorization = request.headers().get("authorization").and_then(|value| value.to_str().ok()).unwrap_or_default().to_owned();
            if let Ok(mut slot) = capture.lock() {
                *slot = Some((request.uri().path().to_owned(), authorization));
            }
            Ok(response)
        };
        let mut ws = tokio_tungstenite::accept_hdr_async(tcp, callback).await?;
        ws.send(Message::Text(
            json!({ "type": "session.closed", "event_id": "evt", "reason": "remote_hangup", "session": { "id": "sess_in" }, "usage": { "seconds": 5.0 } })
                .to_string()
                .into(),
        ))
        .await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    });

    let state = runtime_state(&server.uri(), &format!("{}/v1", server.uri()), Some(&format!("ws://{address}/v1")), 51)?;
    handle_incoming(Arc::clone(&state), incoming("sess_in"), None).await;
    for _ in 0..100 {
        if state.metrics.counter("calls_ended", "end_reason", "CALLER_HANGUP") == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(state.metrics.counter("calls_ended", "end_reason", "CALLER_HANGUP"), 1);
    sideband.await?.map_err(|error| error.to_string())?;
    let handshake = captured.lock().map_err(|_| "poisoned")?.clone().ok_or("sideband handshake not captured")?;
    assert_eq!(handshake, ("/v1/live/sessions/sess_in/attach".to_owned(), "Bearer sk-sim".to_owned()));

    let accept = bodies(&server, "POST", "/accept").await?;
    let session = accept.first().and_then(|body| body.get("session")).ok_or("missing accept body")?;
    assert_eq!(session.get("model"), Some(&json!("gpt-live-1")));
    assert_eq!(session.pointer("/delegation/responses/model"), Some(&json!("gpt-5.6-luna")));
    assert!(session.get("instructions").and_then(Value::as_str).unwrap_or_default().contains("Mesterséges intelligencia alapú asszisztens vagyok"));

    let upserts = bodies(&server, "PUT", "/internal/v1/calls/").await?;
    assert_eq!(upserts.first().and_then(|body| body.get("status")), Some(&json!("IN_PROGRESS")));
    let last = upserts.last().ok_or("missing final upsert")?;
    assert_eq!(last.get("status"), Some(&json!("COMPLETED")));
    assert_eq!(last.get("caller_e164"), Some(&json!("+36301234567")));
    assert_eq!(last.get("outcome"), Some(&json!("ABANDONED")));
    assert_eq!(last.get("connected_seconds"), Some(&json!(5)));
    assert!(state.registry.is_empty());
    Ok(())
}

#[tokio::test]
async fn blocked_tenants_are_rejected_with_a_sip_status_and_recorded() -> TestResult {
    let server = MockServer::start().await;
    let tenant = Uuid::now_v7();
    let version = Uuid::now_v7();
    let mut routing = routing_snapshot(tenant, version);
    routing.tenant_status = "SUSPENDED".into();
    routing.admission_block_reason = Some("TENANT_SUSPENDED".into());
    mount_control(&server, &routing, &agent_snapshot(tenant, version)).await;
    Mock::given(method("POST"))
        .and(path("/v1/live/sessions/sess_blocked/reject"))
        .and(body_json(json!({ "status_code": 403 })))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;
    let state = runtime_state(&server.uri(), &format!("{}/v1", server.uri()), None, 52)?;
    handle_incoming(Arc::clone(&state), incoming("sess_blocked"), None).await;
    let upserts = bodies(&server, "PUT", "/internal/v1/calls/").await?;
    let record = upserts.first().ok_or("missing rejected call record")?;
    assert_eq!(record.get("status"), Some(&json!("REJECTED")));
    assert_eq!(record.get("admission_reject_reason"), Some(&json!("TENANT_SUSPENDED")));
    assert_eq!(record.get("end_reason"), Some(&json!("ADMISSION_REJECTED")));
    let events = bodies(&server, "POST", "/events").await?;
    assert_eq!(events.first().and_then(|batch| batch.pointer("/events/0/event_type")), Some(&json!("call.admission_decided")));
    assert!(bodies(&server, "POST", "/accept").await?.is_empty());
    assert_eq!(state.metrics.counter("admission_rejected", "reason", "TENANT_SUSPENDED"), 1);
    Ok(())
}

#[tokio::test]
async fn calls_over_the_tenant_concurrency_limit_get_busy_here() -> TestResult {
    let server = MockServer::start().await;
    let tenant = Uuid::now_v7();
    let version = Uuid::now_v7();
    let routing = routing_snapshot(tenant, version);
    mount_control(&server, &routing, &agent_snapshot(tenant, version)).await;
    Mock::given(method("POST"))
        .and(path("/v1/live/sessions/sess_busy/reject"))
        .and(body_json(json!({ "status_code": 486 })))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;
    let state = runtime_state(&server.uri(), &format!("{}/v1", server.uri()), None, 53)?;
    for _ in 0..2 {
        let occupied = state.gate.request(Uuid::now_v7(), &routing, "openai")?;
        assert!(matches!(state.gate.acquire(&occupied, &state.metrics).await?, AdmissionVerdict::Admitted { .. }));
    }
    handle_incoming(Arc::clone(&state), incoming("sess_busy"), None).await;
    let upserts = bodies(&server, "PUT", "/internal/v1/calls/").await?;
    assert_eq!(upserts.first().and_then(|body| body.get("admission_reject_reason")), Some(&json!("TENANT_CONCURRENCY_LIMIT")));
    assert!(bodies(&server, "POST", "/accept").await?.is_empty());
    Ok(())
}

#[test]
fn rollout_buckets_are_stable_and_bounded() {
    let call = Uuid::from_u128(42);
    assert_eq!(rollout_bucket(call), rollout_bucket(call));
    assert!((0..200).map(|value| rollout_bucket(Uuid::from_u128(value))).all(|bucket| bucket < 100));
    assert_eq!(sip_status("TENANT_CONCURRENCY_LIMIT"), 486);
    assert_eq!(sip_status("NO_PRODUCTION_AGENT"), 480);
    assert_eq!(sip_status("KILL_SWITCH"), 503);
}
