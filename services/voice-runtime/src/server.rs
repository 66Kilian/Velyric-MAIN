use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tracing::warn;
use uuid::Uuid;

use crate::incoming::{RuntimeState, handle_incoming};
use crate::metrics::Metrics;
use crate::openai::{IncomingCallData, WebhookEnvelope};
use crate::registry::Registry;
use crate::webhook_signature::{SignatureError, WebhookSecret};

const MAX_WEBHOOK_BYTES: usize = 256 * 1024;

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX))
}

fn failure(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "code": code }))).into_response()
}

async fn process_webhook(state: Arc<RuntimeState>, secret: &WebhookSecret, headers: &HeaderMap, body: &Bytes, expected_tenant: Option<Uuid>) -> Response {
    let verification = secret.verify(
        header_value(headers, "webhook-id"),
        header_value(headers, "webhook-timestamp"),
        header_value(headers, "webhook-signature"),
        body,
        unix_now(),
    );
    match verification {
        Ok(()) => {}
        Err(SignatureError::Stale) => {
            state.metrics.increment("webhook_rejections", "reason", "stale");
            return failure(StatusCode::UNAUTHORIZED, "WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE");
        }
        Err(_) => {
            state.metrics.increment("webhook_rejections", "reason", "signature");
            return failure(StatusCode::UNAUTHORIZED, "WEBHOOK_SIGNATURE_INVALID");
        }
    }
    let Ok(envelope) = serde_json::from_slice::<WebhookEnvelope>(body) else {
        return failure(StatusCode::BAD_REQUEST, "MALFORMED_REQUEST");
    };
    let kind: String = envelope.kind.chars().take(64).collect();
    state.metrics.increment("webhooks", "type", &kind);
    if !state.first_delivery(&envelope.id) {
        return (StatusCode::OK, Json(json!({ "status": "duplicate" }))).into_response();
    }
    match envelope.kind.as_str() {
        "live.call.incoming" => match serde_json::from_value::<IncomingCallData>(envelope.data) {
            Ok(data) => {
                tokio::spawn(handle_incoming(Arc::clone(&state), data, expected_tenant));
                (StatusCode::OK, Json(json!({ "status": "accepted" }))).into_response()
            }
            Err(_) => failure(StatusCode::BAD_REQUEST, "MALFORMED_REQUEST"),
        },
        _ => (StatusCode::OK, Json(json!({ "status": "ignored" }))).into_response(),
    }
}

async fn platform_webhook(State(state): State<Arc<RuntimeState>>, headers: HeaderMap, body: Bytes) -> Response {
    let secret = state.platform_webhook_secret.clone();
    process_webhook(state, &secret, &headers, &body, None).await
}

async fn tenant_webhook(State(state): State<Arc<RuntimeState>>, Path(tenant_id): Path<Uuid>, headers: HeaderMap, body: Bytes) -> Response {
    match state.tenant_webhook_secret(tenant_id, &crate::new_trace_id()).await {
        Ok(secret) => process_webhook(state, &secret, &headers, &body, Some(tenant_id)).await,
        Err(reason) => {
            warn!(%tenant_id, reason, "tenant webhook secret unavailable");
            state.metrics.increment("webhook_rejections", "reason", reason);
            failure(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE")
        }
    }
}

pub fn public_router(state: Arc<RuntimeState>) -> Router {
    Router::new()
        .route("/v1/webhooks/openai/live", post(platform_webhook))
        .route("/v1/webhooks/openai/live/{tenant_id}", post(tenant_webhook))
        .layer(DefaultBodyLimit::max(MAX_WEBHOOK_BYTES))
        .with_state(state)
}

pub type Readiness = Arc<dyn Fn() -> bool + Send + Sync>;

pub struct AdminState {
    pub registry: Arc<Registry>,
    pub metrics: Arc<Metrics>,
    pub readiness: Readiness,
}

async fn live() -> Response {
    Json(json!({ "status": "ok" })).into_response()
}

async fn ready(State(state): State<Arc<AdminState>>) -> Response {
    let active_calls = state.registry.len();
    if state.registry.is_draining() {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "status": "draining", "active_calls": active_calls }))).into_response();
    }
    if !(state.readiness)() {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "status": "dependencies_unavailable", "active_calls": active_calls }))).into_response();
    }
    Json(json!({ "status": "ready", "active_calls": active_calls })).into_response()
}

async fn metrics(State(state): State<Arc<AdminState>>) -> Response {
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], state.metrics.render()).into_response()
}

async fn drain(State(state): State<Arc<AdminState>>) -> Response {
    let started = state.registry.start_drain();
    (StatusCode::ACCEPTED, Json(json!({ "status": "draining", "newly_started": started, "active_calls": state.registry.len() }))).into_response()
}

pub fn admin_router(state: Arc<AdminState>) -> Router {
    Router::new()
        .route("/healthz/live", get(live))
        .route("/healthz/ready", get(ready))
        .route("/metrics", get(metrics))
        .route("/admin/drain", post(drain))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{WEBHOOK_SECRET, runtime_state};
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tower::ServiceExt;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    async fn body_json(response: Response) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        Ok(serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await?)?)
    }

    #[tokio::test]
    async fn admin_endpoints_report_readiness_metrics_and_drain() -> TestResult {
        let registry = Arc::new(Registry::default());
        let metrics = Arc::new(Metrics::new(crate::METRICS_PREFIX));
        metrics.increment("webhooks", "type", "live.call.incoming");
        let router = admin_router(Arc::new(AdminState { registry: Arc::clone(&registry), metrics, readiness: Arc::new(|| true) }));
        let ready = router.clone().oneshot(Request::get("/healthz/ready").body(Body::empty())?).await?;
        assert_eq!(ready.status(), StatusCode::OK);
        let text = to_bytes(router.clone().oneshot(Request::get("/metrics").body(Body::empty())?).await?.into_body(), 1_000_000).await?;
        assert!(String::from_utf8(text.to_vec())?.contains("velyric_voice_runtime_webhooks_total{type=\"live.call.incoming\"} 1"));
        let drained = router.clone().oneshot(Request::post("/admin/drain").body(Body::empty())?).await?;
        assert_eq!(drained.status(), StatusCode::ACCEPTED);
        let after = router.clone().oneshot(Request::get("/healthz/ready").body(Body::empty())?).await?;
        assert_eq!(after.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body_json(after).await?.get("status"), Some(&json!("draining")));
        assert!(registry.is_draining());
        let unready = admin_router(Arc::new(AdminState { registry: Arc::new(Registry::default()), metrics: Arc::new(Metrics::new(crate::METRICS_PREFIX)), readiness: Arc::new(|| false) }));
        assert_eq!(unready.oneshot(Request::get("/healthz/ready").body(Body::empty())?).await?.status(), StatusCode::SERVICE_UNAVAILABLE);
        Ok(())
    }

    #[tokio::test]
    async fn webhooks_require_valid_signatures_and_are_deduplicated() -> TestResult {
        let state = runtime_state("http://127.0.0.1:9", "http://127.0.0.1:9/v1", None, 41)?;
        let router = public_router(Arc::clone(&state));
        let body = json!({ "id": "evt_1", "object": "event", "created_at": 1, "type": "batch.completed", "data": {} }).to_string();
        let secret = WebhookSecret::parse(WEBHOOK_SECRET)?;
        let now = unix_now();
        let signed = |signature: String| -> Result<Request<Body>, axum::http::Error> {
            Request::post("/v1/webhooks/openai/live")
                .header("content-type", "application/json")
                .header("webhook-id", "wh_1")
                .header("webhook-timestamp", now.to_string())
                .header("webhook-signature", signature)
                .body(Body::from(body.clone()))
        };
        let forged = router.clone().oneshot(signed("v1,AAAA".to_owned())?).await?;
        assert_eq!(forged.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(forged).await?.get("code"), Some(&json!("WEBHOOK_SIGNATURE_INVALID")));
        let signature = secret.sign("wh_1", now, body.as_bytes())?;
        let first = router.clone().oneshot(signed(signature.clone())?).await?;
        assert_eq!(body_json(first).await?.get("status"), Some(&json!("ignored")));
        let second = router.clone().oneshot(signed(signature)?).await?;
        assert_eq!(body_json(second).await?.get("status"), Some(&json!("duplicate")));
        let stale_signature = secret.sign("wh_1", now - 3_600, body.as_bytes())?;
        let stale = router
            .oneshot(
                Request::post("/v1/webhooks/openai/live")
                    .header("webhook-id", "wh_1")
                    .header("webhook-timestamp", (now - 3_600).to_string())
                    .header("webhook-signature", stale_signature)
                    .body(Body::from(body.clone()))?,
            )
            .await?;
        assert_eq!(body_json(stale).await?.get("code"), Some(&json!("WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE")));
        assert_eq!(state.metrics.counter("webhook_rejections", "reason", "signature"), 1);
        Ok(())
    }
}
