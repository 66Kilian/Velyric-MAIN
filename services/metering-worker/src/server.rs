use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::future::BoxFuture;
use serde_json::json;

use crate::metrics::Metrics;

pub type ReadinessCheck = Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>;

pub struct HealthState {
    pub metrics: Arc<Metrics>,
    pub readiness: ReadinessCheck,
}

async fn live() -> Response {
    Json(json!({ "status": "ok" })).into_response()
}

async fn ready(State(state): State<Arc<HealthState>>) -> Response {
    if (state.readiness)().await {
        Json(json!({ "status": "ready" })).into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "status": "dependencies_unavailable" }))).into_response()
    }
}

async fn metrics(State(state): State<Arc<HealthState>>) -> Response {
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], state.metrics.render()).into_response()
}

pub fn router(state: Arc<HealthState>) -> Router {
    Router::new().route("/healthz/live", get(live)).route("/healthz/ready", get(ready)).route("/metrics", get(metrics)).with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use futures_util::FutureExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tower::ServiceExt;

    #[tokio::test]
    async fn readiness_follows_dependency_checks_and_metrics_render() -> Result<(), Box<dyn std::error::Error>> {
        let healthy = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&healthy);
        let metrics = Arc::new(Metrics::new(crate::METRICS_PREFIX));
        metrics.increment("usage_events", "result", "recorded");
        let app = router(Arc::new(HealthState {
            metrics,
            readiness: Arc::new(move || {
                let value = flag.load(Ordering::SeqCst);
                async move { value }.boxed()
            }),
        }));
        assert_eq!(app.clone().oneshot(Request::get("/healthz/ready").body(Body::empty())?).await?.status(), StatusCode::OK);
        healthy.store(false, Ordering::SeqCst);
        assert_eq!(app.clone().oneshot(Request::get("/healthz/ready").body(Body::empty())?).await?.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = to_bytes(app.oneshot(Request::get("/metrics").body(Body::empty())?).await?.into_body(), 1_000_000).await?;
        assert!(String::from_utf8(body.to_vec())?.contains("velyric_metering_worker_usage_events_total{result=\"recorded\"} 1"));
        Ok(())
    }
}
