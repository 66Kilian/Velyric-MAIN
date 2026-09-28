#![forbid(unsafe_code)]

pub mod budget;
pub mod config;
pub mod consumer;
pub mod handlers;
pub mod pricing;
pub mod server;
pub mod store;

pub use velyric_service_kit::metrics;

pub const METRICS_PREFIX: &str = "velyric_metering_worker_";

pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
