use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tracing::warn;
use uuid::Uuid;
use velyric_call_protocol::UsageRecord;

use crate::metrics::Metrics;
use crate::pricing::{PriceTable, expected_unit};
use crate::store::{RecordOutcome, Store, StoreError};

const FUTURE_TOLERANCE: time::Duration = time::Duration::minutes(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposition {
    Ack,
    Retry { delay: Duration },
    DeadLetter { reason: String },
}

fn parse_timestamp(raw: &str, now: OffsetDateTime) -> Result<OffsetDateTime, String> {
    let value = OffsetDateTime::parse(raw, &Rfc3339).map_err(|_| "occurred_at must be an RFC 3339 timestamp".to_owned())?;
    if value > now + FUTURE_TOLERANCE {
        return Err("occurred_at is in the future".to_owned());
    }
    Ok(value)
}

pub fn parse_usage(subject: &str, payload: &[u8], now: OffsetDateTime) -> Result<(UsageRecord, OffsetDateTime), String> {
    let record: UsageRecord = serde_json::from_slice(payload).map_err(|error| format!("invalid usage payload: {error}"))?;
    if subject != format!("usage.v1.{}.{}", record.tenant_id, record.metric) {
        return Err("subject does not match the usage record".to_owned());
    }
    match expected_unit(&record.metric) {
        Some(unit) if unit == record.unit => {}
        Some(unit) => return Err(format!("metric {} must use unit {unit}", record.metric)),
        None => return Err(format!("unknown usage metric {}", record.metric)),
    }
    if record.quantity < 0 {
        return Err("usage quantity must not be negative".to_owned());
    }
    let occurred_at = parse_timestamp(&record.occurred_at, now)?;
    Ok((record, occurred_at))
}

#[derive(Deserialize)]
struct CallEventMessage {
    event_id: Uuid,
    tenant_id: Uuid,
    call_id: Uuid,
    event_type: String,
    occurred_at: String,
    payload: Value,
}

pub fn parse_call_ended(subject: &str, payload: &[u8], now: OffsetDateTime) -> Result<Option<(UsageRecord, OffsetDateTime)>, String> {
    let message: CallEventMessage = serde_json::from_slice(payload).map_err(|error| format!("invalid call event payload: {error}"))?;
    if subject != format!("call.v1.{}.{}.{}", message.tenant_id, message.call_id, message.event_type) {
        return Err("subject does not match the call event".to_owned());
    }
    if message.event_type != "call.ended" {
        return Ok(None);
    }
    let connected = message.payload.get("connected_seconds").and_then(Value::as_u64).ok_or("call.ended payload is missing connected_seconds")?;
    if connected == 0 {
        return Ok(None);
    }
    let occurred_at = parse_timestamp(&message.occurred_at, now)?;
    Ok(Some((
        UsageRecord {
            source_event_id: message.event_id,
            tenant_id: message.tenant_id,
            call_id: Some(message.call_id),
            metric: "billable_voice_seconds".to_owned(),
            quantity: i64::try_from(connected).map_err(|_| "connected_seconds is out of range".to_owned())?,
            unit: "SECONDS".to_owned(),
            provider: Some("openai".to_owned()),
            model: None,
            occurred_at: message.occurred_at,
        },
        occurred_at,
    )))
}

#[must_use]
pub fn retry_delay(delivered: i64) -> Duration {
    Duration::from_secs(u64::try_from(delivered.clamp(1, 30)).unwrap_or(1) * 2)
}

pub async fn record(store: &Store, prices: &PriceTable, metrics: &Metrics, usage: &UsageRecord, occurred_at: OffsetDateTime, delivered: i64, max_deliver: i64) -> Disposition {
    match store.record_usage(usage, occurred_at, prices).await {
        Ok(RecordOutcome::Duplicate) => {
            metrics.increment("usage_events", "result", "duplicate");
            Disposition::Ack
        }
        Ok(RecordOutcome::Recorded { cost_usd_micros, unpriced, hard_cap_reached }) => {
            metrics.increment("usage_events", "result", "recorded");
            metrics.add("usage_cost_usd_micros", "metric", &usage.metric, cost_usd_micros);
            if unpriced {
                warn!(model = ?usage.model, metric = %usage.metric, "usage has no configured token price; cost recorded as zero");
                metrics.increment("unpriced_usage", "metric", &usage.metric);
            }
            if hard_cap_reached {
                metrics.increment("spend_hard_cap_events", "metric", &usage.metric);
            }
            Disposition::Ack
        }
        Err(StoreError::Invalid(detail)) => Disposition::DeadLetter { reason: detail },
        Err(StoreError::MissingReference(detail) | StoreError::Unavailable(detail)) => {
            if delivered >= max_deliver {
                Disposition::DeadLetter { reason: format!("gave up after {delivered} deliveries: {detail}") }
            } else {
                Disposition::Retry { delay: retry_delay(delivered) }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> Result<OffsetDateTime, time::error::Parse> {
        OffsetDateTime::parse("2026-09-14T10:00:00Z", &Rfc3339)
    }

    #[test]
    fn usage_records_must_match_their_subject_unit_and_time_window() -> Result<(), Box<dyn std::error::Error>> {
        let tenant = Uuid::now_v7();
        let record = json!({
            "source_event_id": Uuid::now_v7(), "tenant_id": tenant, "call_id": null, "metric": "backend_input_tokens",
            "quantity": 1200, "unit": "TOKENS", "provider": "openai", "model": "gpt-5.6-luna", "occurred_at": "2026-09-14T09:59:00Z"
        });
        let subject = format!("usage.v1.{tenant}.backend_input_tokens");
        let (parsed, occurred_at) = parse_usage(&subject, record.to_string().as_bytes(), now()?)?;
        assert_eq!(parsed.quantity, 1_200);
        assert_eq!(occurred_at, OffsetDateTime::parse("2026-09-14T09:59:00Z", &Rfc3339)?);
        assert!(parse_usage(&format!("usage.v1.{}.backend_input_tokens", Uuid::now_v7()), record.to_string().as_bytes(), now()?).is_err());
        let mut wrong_unit = record.clone();
        wrong_unit["unit"] = json!("SECONDS");
        assert!(parse_usage(&subject, wrong_unit.to_string().as_bytes(), now()?).is_err());
        let mut future = record.clone();
        future["occurred_at"] = json!("2026-09-14T11:00:00Z");
        assert_eq!(parse_usage(&subject, future.to_string().as_bytes(), now()?).err().as_deref(), Some("occurred_at is in the future"));
        let mut unknown = record;
        unknown["metric"] = json!("free_minutes");
        assert!(parse_usage(&format!("usage.v1.{tenant}.free_minutes"), unknown.to_string().as_bytes(), now()?).is_err());
        assert!(parse_usage(&subject, b"not json", now()?).is_err());
        Ok(())
    }

    #[test]
    fn call_ended_events_become_billable_seconds() -> Result<(), Box<dyn std::error::Error>> {
        let tenant = Uuid::now_v7();
        let call = Uuid::now_v7();
        let event = Uuid::now_v7();
        let message = |event_type: &str, seconds: u64| {
            json!({
                "event_id": event, "tenant_id": tenant, "call_id": call, "seq": 9, "event_type": event_type, "schema_version": 1,
                "occurred_at": "2026-09-14T09:58:00Z", "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
                "payload": { "end_reason": "CALLER_HANGUP", "status": "COMPLETED", "connected_seconds": seconds }
            })
            .to_string()
        };
        let subject = format!("call.v1.{tenant}.{call}.call.ended");
        let (usage, _) = parse_call_ended(&subject, message("call.ended", 42).as_bytes(), now()?)?.ok_or("expected usage")?;
        assert_eq!((usage.metric.as_str(), usage.quantity, usage.unit.as_str(), usage.source_event_id, usage.call_id), ("billable_voice_seconds", 42, "SECONDS", event, Some(call)));
        assert!(parse_call_ended(&subject, message("call.ended", 0).as_bytes(), now()?)?.is_none());
        let started = format!("call.v1.{tenant}.{call}.call.started");
        assert!(parse_call_ended(&started, message("call.started", 42).as_bytes(), now()?)?.is_none());
        assert!(parse_call_ended(&started, message("call.ended", 42).as_bytes(), now()?).is_err());
        Ok(())
    }

    #[test]
    fn retries_back_off_linearly_up_to_a_minute() {
        assert_eq!(retry_delay(0), Duration::from_secs(2));
        assert_eq!(retry_delay(5), Duration::from_secs(10));
        assert_eq!(retry_delay(500), Duration::from_secs(60));
    }
}
