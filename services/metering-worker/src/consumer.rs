use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_nats::HeaderMap;
use async_nats::jetstream::{self, AckKind, consumer, stream};
use bytes::Bytes;
use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};

use crate::handlers::Disposition;
use crate::metrics::Metrics;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Copy)]
pub struct StreamSpec {
    pub name: &'static str,
    pub subjects: &'static [&'static str],
    pub max_age: Duration,
}

pub const USAGE_STREAM: StreamSpec = StreamSpec { name: "USAGE", subjects: &["usage.v1.>"], max_age: Duration::from_secs(14 * 86_400) };
pub const CALL_EVENTS_STREAM: StreamSpec = StreamSpec { name: "CALL_EVENTS", subjects: &["call.v1.>"], max_age: Duration::from_secs(7 * 86_400) };
pub const DEAD_LETTER_STREAM: StreamSpec = StreamSpec { name: "DEAD_LETTER", subjects: &["dlq.v1.>"], max_age: Duration::from_secs(30 * 86_400) };

#[derive(Debug, Clone, Copy)]
pub struct ConsumerSpec {
    pub stream: &'static str,
    pub durable: &'static str,
    pub filter: &'static str,
    pub pending_gauge: &'static str,
}

pub const USAGE_CONSUMER: ConsumerSpec = ConsumerSpec { stream: "USAGE", durable: "metering-usage", filter: "usage.v1.>", pending_gauge: "usage_consumer_pending" };
pub const CALL_EVENTS_CONSUMER: ConsumerSpec =
    ConsumerSpec { stream: "CALL_EVENTS", durable: "metering-call-events", filter: "call.v1.*.*.call.ended", pending_gauge: "call_events_consumer_pending" };

pub async fn ensure_streams(context: &jetstream::Context, replicas: usize) -> Result<(), BoxError> {
    for spec in [USAGE_STREAM, CALL_EVENTS_STREAM, DEAD_LETTER_STREAM] {
        context
            .get_or_create_stream(stream::Config {
                name: spec.name.to_owned(),
                subjects: spec.subjects.iter().map(|subject| (*subject).to_owned()).collect(),
                retention: stream::RetentionPolicy::Limits,
                storage: stream::StorageType::File,
                num_replicas: replicas,
                max_age: spec.max_age,
                duplicate_window: Duration::from_secs(120),
                ..Default::default()
            })
            .await?;
    }
    Ok(())
}

async fn dead_letter(context: &jetstream::Context, spec: ConsumerSpec, message: &jetstream::Message, reason: &str) -> Result<(), BoxError> {
    let sequence = message.info().map(|info| info.stream_sequence).unwrap_or_default();
    let mut headers = HeaderMap::new();
    headers.insert("Nats-Msg-Id", format!("{}:{}:{sequence}", spec.stream, spec.durable).as_str());
    headers.insert("Velyric-Original-Subject", message.subject.as_str());
    headers.insert("Velyric-Dead-Letter-Reason", reason.chars().take(200).collect::<String>().as_str());
    let ack = context.publish_with_headers(format!("dlq.v1.{}.{}", spec.stream, spec.durable), headers, message.payload.clone()).await?;
    tokio::time::timeout(Duration::from_secs(5), ack).await.map_err(|_| "dead letter acknowledgement timed out")??;
    Ok(())
}

pub async fn run<F, Fut>(
    context: jetstream::Context,
    spec: ConsumerSpec,
    max_deliver: i64,
    metrics: Arc<Metrics>,
    shutdown: CancellationToken,
    handler: F,
) -> Result<(), BoxError>
where
    F: Fn(String, Bytes, i64) -> Fut,
    Fut: Future<Output = Disposition>,
{
    let stream = context.get_stream(spec.stream).await?;
    let mut pull: consumer::PullConsumer = stream
        .get_or_create_consumer(
            spec.durable,
            consumer::pull::Config {
                durable_name: Some(spec.durable.to_owned()),
                filter_subject: spec.filter.to_owned(),
                ack_policy: consumer::AckPolicy::Explicit,
                ack_wait: Duration::from_secs(30),
                max_deliver: max_deliver + 5,
                deliver_policy: consumer::DeliverPolicy::All,
                ..Default::default()
            },
        )
        .await?;
    let mut messages = pull.messages().await?;
    let mut lag_ticker = tokio::time::interval(Duration::from_secs(15));
    loop {
        let next = tokio::select! {
            () = shutdown.cancelled() => break,
            _ = lag_ticker.tick() => {
                if let Ok(info) = pull.info().await {
                    metrics.set_gauge(spec.pending_gauge, i64::try_from(info.num_pending).unwrap_or(i64::MAX));
                }
                continue;
            }
            next = messages.next() => next,
        };
        let Some(next) = next else {
            break;
        };
        let message = match next {
            Ok(message) => message,
            Err(error) => {
                warn!(error = %error, consumer = spec.durable, "JetStream delivery error");
                metrics.increment("consumer_errors", "consumer", spec.durable);
                continue;
            }
        };
        let delivered = message.info().map(|info| info.delivered).unwrap_or(1);
        let disposition = handler(message.subject.to_string(), message.payload.clone(), delivered).await;
        let acknowledged = match disposition {
            Disposition::Ack => message.ack().await,
            Disposition::Retry { delay } => {
                metrics.increment("consumer_retries", "consumer", spec.durable);
                message.ack_with(AckKind::Nak(Some(delay))).await
            }
            Disposition::DeadLetter { reason } => match dead_letter(&context, spec, &message, &reason).await {
                Ok(()) => {
                    error!(consumer = spec.durable, subject = %message.subject, reason = %reason, "message moved to the dead letter stream");
                    metrics.increment("dead_letters", "consumer", spec.durable);
                    message.ack_with(AckKind::Term).await
                }
                Err(error) => {
                    warn!(error = %error, consumer = spec.durable, "dead letter publish failed; message will be redelivered");
                    message.ack_with(AckKind::Nak(Some(Duration::from_secs(5)))).await
                }
            },
        };
        if let Err(error) = acknowledged {
            warn!(error = %error, consumer = spec.durable, "message acknowledgement failed");
            metrics.increment("consumer_errors", "consumer", spec.durable);
        }
    }
    Ok(())
}
