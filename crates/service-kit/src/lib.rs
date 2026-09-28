#![forbid(unsafe_code)]

pub mod env;
pub mod metrics;
pub mod secrets;

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

#[must_use]
pub fn new_trace_id() -> String {
    Uuid::new_v4().simple().to_string()
}

#[must_use]
pub fn rfc3339(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).unwrap_or_else(|_| value.unix_timestamp().to_string())
}
