#![forbid(unsafe_code)]

use std::sync::OnceLock;

use thiserror::Error;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

#[derive(Debug, Error)]
pub enum TelemetryError {
    #[error("invalid log level filter: {0}")]
    Filter(String),
    #[error("telemetry was already initialised")]
    AlreadyInitialised,
}

#[derive(Debug, Clone)]
pub struct TelemetryConfig {
    pub service_name: &'static str,
    pub service_version: &'static str,
    pub environment: String,
    pub log_level: String,
    pub json: bool,
}

static INITIALISED: OnceLock<()> = OnceLock::new();

pub fn init(config: &TelemetryConfig) -> Result<(), TelemetryError> {
    let filter = EnvFilter::try_new(&config.log_level).map_err(|error| TelemetryError::Filter(error.to_string()))?;
    let registry = tracing_subscriber::registry().with(filter);
    let result = if config.json {
        registry
            .with(fmt::layer().json().with_current_span(true).with_span_list(false).with_target(false))
            .try_init()
    } else {
        registry.with(fmt::layer().with_target(false)).try_init()
    };
    result.map_err(|_| TelemetryError::AlreadyInitialised)?;
    let _ = INITIALISED.set(());
    tracing::info!(service = config.service_name, version = config.service_version, environment = %config.environment, "telemetry initialised");
    Ok(())
}

#[must_use]
pub fn redact_e164(value: &str) -> String {
    let characters: Vec<char> = value.chars().collect();
    if characters.len() <= 6 {
        return "*".repeat(characters.len());
    }
    let head: String = characters.iter().take(4).collect();
    let tail: String = characters.iter().skip(characters.len() - 2).collect();
    format!("{head}{}{tail}", "*".repeat(characters.len() - 6))
}

#[must_use]
pub fn redact_free_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut digits = String::new();
    let flush = |digits: &mut String, output: &mut String| {
        if digits.chars().filter(char::is_ascii_digit).count() >= 7 {
            output.push_str("[REDACTED_NUMBER]");
        } else {
            output.push_str(digits);
        }
        digits.clear();
    };
    for character in value.chars() {
        if character.is_ascii_digit() || (!digits.is_empty() && matches!(character, ' ' | '-' | '.')) || (digits.is_empty() && character == '+') {
            digits.push(character);
        } else {
            flush(&mut digits, &mut output);
            output.push(character);
        }
    }
    flush(&mut digits, &mut output);
    redact_emails(&output)
}

fn redact_emails(value: &str) -> String {
    value
        .split(' ')
        .map(|word| {
            let trimmed = word.trim_matches(|character: char| matches!(character, ',' | '.' | ';' | ':' | '!' | '?' | '(' | ')'));
            match trimmed.split_once('@') {
                Some((local, domain)) if !local.is_empty() && domain.contains('.') => word.replace(trimmed, "[REDACTED_EMAIL]"),
                _ => word.to_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_phone_numbers() {
        assert_eq!(redact_e164("+36301234567"), "+363******67");
        assert_eq!(redact_e164("+3612"), "*****");
    }

    #[test]
    fn scrubs_numbers_and_emails_from_free_text() {
        let redacted = redact_free_text("Hívjon a +36 30 123 4567 számon vagy írjon: kovacs.k@pelda.hu, köszönöm! Asztal 4 főre.");
        assert!(!redacted.contains("4567"));
        assert!(!redacted.contains("kovacs.k@pelda.hu"));
        assert!(redacted.contains("[REDACTED_NUMBER]"));
        assert!(redacted.contains("[REDACTED_EMAIL]"));
        assert!(redacted.contains("4 főre"));
    }
}
