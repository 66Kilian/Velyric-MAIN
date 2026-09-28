use std::sync::Arc;
use std::time::Duration;

use async_nats::HeaderMap;
use async_nats::jetstream;
use bytes::Bytes;
use serde_json::json;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tracing::{error, warn};
use uuid::Uuid;
use velyric_call_protocol::{CallEventRecord, CallEventsBatch, TranscriptSegment, UsageRecord};

use crate::control_api::{ControlApiClient, ControlApiError};
use crate::metrics::Metrics;

const MAX_BATCH: usize = 500;
const FLUSH_THRESHOLD: usize = 100;
const CLOSE_ATTEMPTS: u32 = 5;

enum SinkItem {
    Event(CallEventRecord),
    Transcript(TranscriptSegment),
    Usage(UsageRecord),
    Flush(oneshot::Sender<bool>),
}

#[derive(Clone)]
pub struct EventSink {
    sender: mpsc::Sender<SinkItem>,
}

impl EventSink {
    async fn push(&self, item: SinkItem, kind: &'static str) {
        if self.sender.send(item).await.is_err() {
            error!(kind, "call event sink is closed; item dropped");
        }
    }

    pub async fn event(&self, record: CallEventRecord) {
        self.push(SinkItem::Event(record), "event").await;
    }

    pub async fn transcript(&self, segment: TranscriptSegment) {
        self.push(SinkItem::Transcript(segment), "transcript").await;
    }

    pub async fn usage(&self, record: UsageRecord) {
        self.push(SinkItem::Usage(record), "usage").await;
    }

    pub async fn flush(&self, timeout: Duration) -> bool {
        let (sender, receiver) = oneshot::channel();
        if self.sender.send(SinkItem::Flush(sender)).await.is_err() {
            return false;
        }
        matches!(tokio::time::timeout(timeout, receiver).await, Ok(Ok(true)))
    }
}

pub struct SinkContext {
    pub control: Arc<ControlApiClient>,
    pub jetstream: Option<jetstream::Context>,
    pub metrics: Arc<Metrics>,
    pub tenant_id: Uuid,
    pub call_id: Uuid,
    pub trace_id: String,
}

#[must_use]
pub fn spawn(context: SinkContext) -> (EventSink, JoinHandle<()>) {
    let (sender, receiver) = mpsc::channel(4_096);
    (EventSink { sender }, tokio::spawn(run(context, receiver)))
}

#[derive(Default)]
struct Pending {
    events: Vec<CallEventRecord>,
    transcript: Vec<TranscriptSegment>,
    unpublished_events: Vec<CallEventRecord>,
    usage: Vec<UsageRecord>,
}

impl Pending {
    fn is_empty(&self) -> bool {
        self.events.is_empty() && self.transcript.is_empty() && self.unpublished_events.is_empty() && self.usage.is_empty()
    }

    fn over_threshold(&self) -> bool {
        self.events.len() >= FLUSH_THRESHOLD || self.transcript.len() >= FLUSH_THRESHOLD || self.usage.len() >= FLUSH_THRESHOLD
    }
}

async fn run(context: SinkContext, mut receiver: mpsc::Receiver<SinkItem>) {
    let mut pending = Pending::default();
    let mut waiters: Vec<oneshot::Sender<bool>> = Vec::new();
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut open = true;
    while open {
        let mut due = false;
        tokio::select! {
            item = receiver.recv() => match item {
                Some(SinkItem::Event(record)) => {
                    pending.unpublished_events.push(record.clone());
                    pending.events.push(record);
                }
                Some(SinkItem::Transcript(segment)) => pending.transcript.push(segment),
                Some(SinkItem::Usage(record)) => pending.usage.push(record),
                Some(SinkItem::Flush(waiter)) => {
                    waiters.push(waiter);
                    due = true;
                }
                None => {
                    open = false;
                    due = true;
                }
            },
            _ = ticker.tick() => due = true,
        }
        if !(due || pending.over_threshold()) || (pending.is_empty() && waiters.is_empty()) {
            continue;
        }
        let delivered = flush(&context, &mut pending).await;
        for waiter in waiters.drain(..) {
            let _ = waiter.send(delivered);
        }
    }
    let mut attempt = 0_u32;
    while !pending.is_empty() && attempt < CLOSE_ATTEMPTS {
        attempt += 1;
        tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
        flush(&context, &mut pending).await;
    }
    if !pending.is_empty() {
        error!(
            call_id = %context.call_id,
            events = pending.events.len(),
            transcript = pending.transcript.len(),
            usage = pending.usage.len(),
            "call data could not be delivered before the session ended"
        );
        context.metrics.increment("call_data_undelivered", "call_phase", "session_end");
    }
}

async fn publish(jetstream: &jetstream::Context, subject: String, message_id: &str, payload: Vec<u8>) -> Result<(), String> {
    let mut headers = HeaderMap::new();
    headers.insert("Nats-Msg-Id", message_id);
    let ack = jetstream.publish_with_headers(subject, headers, Bytes::from(payload)).await.map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), ack)
        .await
        .map_err(|_| "publish acknowledgement timed out".to_owned())?
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn publish_pending(context: &SinkContext, pending: &mut Pending) -> bool {
    let Some(jetstream) = &context.jetstream else {
        pending.unpublished_events.clear();
        pending.usage.clear();
        return true;
    };
    let mut failed_events = Vec::new();
    for record in pending.unpublished_events.drain(..) {
        let subject = format!("call.v1.{}.{}.{}", context.tenant_id, context.call_id, record.event_type);
        let payload = json!({
            "event_id": record.event_id,
            "tenant_id": context.tenant_id,
            "call_id": context.call_id,
            "seq": record.seq,
            "event_type": record.event_type,
            "schema_version": record.schema_version,
            "occurred_at": record.occurred_at,
            "trace_id": context.trace_id,
            "payload": record.payload,
        });
        if let Err(error) = publish(jetstream, subject, &record.event_id.to_string(), payload.to_string().into_bytes()).await {
            warn!(error = %error, event_type = %record.event_type, "call event publish failed");
            context.metrics.increment("nats_publish_errors", "stream", "CALL_EVENTS");
            failed_events.push(record);
        }
    }
    pending.unpublished_events = failed_events;
    let mut failed_usage = Vec::new();
    for record in pending.usage.drain(..) {
        let subject = format!("usage.v1.{}.{}", record.tenant_id, record.metric);
        let payload = match serde_json::to_vec(&record) {
            Ok(payload) => payload,
            Err(error) => {
                error!(error = %error, "usage record could not be serialized");
                continue;
            }
        };
        if let Err(error) = publish(jetstream, subject, &record.source_event_id.to_string(), payload).await {
            warn!(error = %error, metric = %record.metric, "usage publish failed");
            context.metrics.increment("nats_publish_errors", "stream", "USAGE");
            failed_usage.push(record);
        }
    }
    pending.usage = failed_usage;
    pending.unpublished_events.is_empty() && pending.usage.is_empty()
}

const fn is_poison(error: &ControlApiError) -> bool {
    matches!(error, ControlApiError::Status { status, .. } if *status >= 400 && *status < 500 && *status != 404 && *status != 408 && *status != 409 && *status != 429)
}

async fn flush(context: &SinkContext, pending: &mut Pending) -> bool {
    let published = publish_pending(context, pending).await;
    while !pending.events.is_empty() || !pending.transcript.is_empty() {
        let batch = CallEventsBatch {
            events: pending.events.iter().take(MAX_BATCH).cloned().collect(),
            transcript: pending.transcript.iter().take(MAX_BATCH).cloned().collect(),
        };
        match context.control.post_events(context.tenant_id, context.call_id, &batch, &context.trace_id).await {
            Ok(()) => {
                pending.events.drain(..batch.events.len());
                pending.transcript.drain(..batch.transcript.len());
            }
            Err(error) if is_poison(&error) => {
                error!(error = %error, call_id = %context.call_id, events = batch.events.len(), "control-api rejected a call event batch; dropping it");
                context.metrics.increment("call_data_undelivered", "call_phase", "rejected_batch");
                pending.events.drain(..batch.events.len());
                pending.transcript.drain(..batch.transcript.len());
            }
            Err(error) => {
                warn!(error = %error, call_id = %context.call_id, "call event delivery failed; will retry");
                context.metrics.increment("control_api_errors", "operation", "post_events");
                return false;
            }
        }
    }
    published
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestKeys;
    use serde_json::{Map, Value};
    use url::Url;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn record(seq: u64) -> CallEventRecord {
        CallEventRecord {
            event_id: Uuid::now_v7(),
            seq,
            event_type: "call.conversation_state_changed".into(),
            schema_version: 1,
            occurred_at: "2026-09-14T10:00:00Z".into(),
            payload: Map::new(),
        }
    }

    #[tokio::test]
    async fn batches_events_with_transcript_and_retries_after_transient_failures() -> TestResult {
        crate::install_crypto_provider();
        let server = MockServer::start().await;
        let tenant = Uuid::now_v7();
        let call = Uuid::now_v7();
        let route = format!("/internal/v1/calls/{call}/events");
        Mock::given(method("POST")).and(path(route.clone())).respond_with(ResponseTemplate::new(503)).up_to_n_times(5).mount(&server).await;
        Mock::given(method("POST"))
            .and(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"accepted": 2, "inserted": 2, "transcript_inserted": 1})))
            .mount(&server)
            .await;
        let keys = TestKeys::new(3)?;
        let control = Arc::new(ControlApiClient::new(
            reqwest::Client::builder().build()?,
            Url::parse(&server.uri())?,
            Arc::new(keys.signer("voice-runtime")?),
            None,
            "ci",
        ));
        let (sink, handle) = spawn(SinkContext {
            control,
            jetstream: None,
            metrics: Arc::new(Metrics::new(crate::METRICS_PREFIX)),
            tenant_id: tenant,
            call_id: call,
            trace_id: "4bf92f3577b34da6a3ce929d0e0e4736".into(),
        });
        sink.event(record(1)).await;
        sink.event(record(2)).await;
        sink.transcript(TranscriptSegment { seq: 1, speaker: "CALLER".into(), language: Some("hu".into()), start_ms: 0, end_ms: 900, content: "Szeretnék időpontot.".into() })
            .await;
        assert!(!sink.flush(Duration::from_secs(10)).await);
        assert!(sink.flush(Duration::from_secs(10)).await);
        drop(sink);
        handle.await?;
        let requests = server.received_requests().await.ok_or("no requests")?;
        let last: Value = serde_json::from_slice(&requests.last().ok_or("no request")?.body)?;
        assert_eq!(last.pointer("/events/0/seq"), Some(&json!(1)));
        assert_eq!(last.pointer("/events/1/seq"), Some(&json!(2)));
        assert_eq!(last.pointer("/transcript/0/content"), Some(&json!("Szeretnék időpontot.")));
        assert_eq!(requests.iter().filter(|request| request.method.as_str() == "POST").count(), 6);
        Ok(())
    }

    #[tokio::test]
    async fn drops_batches_that_the_control_api_rejects_as_invalid() -> TestResult {
        crate::install_crypto_provider();
        let server = MockServer::start().await;
        let call = Uuid::now_v7();
        Mock::given(method("POST"))
            .and(path(format!("/internal/v1/calls/{call}/events")))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({"code": "VALIDATION_FAILED"})))
            .expect(1)
            .mount(&server)
            .await;
        let keys = TestKeys::new(4)?;
        let metrics = Arc::new(Metrics::new(crate::METRICS_PREFIX));
        let control = Arc::new(ControlApiClient::new(
            reqwest::Client::builder().build()?,
            Url::parse(&server.uri())?,
            Arc::new(keys.signer("voice-runtime")?),
            None,
            "ci",
        ));
        let (sink, handle) = spawn(SinkContext {
            control,
            jetstream: None,
            metrics: Arc::clone(&metrics),
            tenant_id: Uuid::now_v7(),
            call_id: call,
            trace_id: "4bf92f3577b34da6a3ce929d0e0e4736".into(),
        });
        sink.event(record(1)).await;
        assert!(sink.flush(Duration::from_secs(5)).await);
        drop(sink);
        handle.await?;
        assert_eq!(metrics.counter("call_data_undelivered", "call_phase", "rejected_batch"), 1);
        Ok(())
    }
}
