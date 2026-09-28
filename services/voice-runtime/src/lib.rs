#![forbid(unsafe_code)]

pub mod admission;
pub mod commands;
pub mod config;
pub mod control_api;
pub mod events;
pub mod incoming;
pub mod openai;
pub mod prompt;
pub mod registry;
pub mod server;
pub mod session;
pub mod sip;
pub mod webhook_signature;

#[cfg(test)]
pub(crate) mod test_support;

pub use velyric_service_kit::{metrics, secrets};

pub const METRICS_PREFIX: &str = "velyric_voice_runtime_";

pub use velyric_service_kit::{new_trace_id, rfc3339};

pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
