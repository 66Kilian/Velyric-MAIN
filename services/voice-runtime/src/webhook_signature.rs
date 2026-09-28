use std::fmt;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use thiserror::Error;

pub const TOLERANCE_SECONDS: u64 = 300;

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum SignatureError {
    #[error("webhook signature headers are missing")]
    MissingHeaders,
    #[error("webhook timestamp is invalid")]
    InvalidTimestamp,
    #[error("webhook timestamp is outside the tolerance window")]
    Stale,
    #[error("webhook signing secret is invalid")]
    InvalidSecret,
    #[error("webhook signature does not match")]
    Mismatch,
}

#[derive(Clone)]
pub struct WebhookSecret {
    key: Vec<u8>,
}

impl fmt::Debug for WebhookSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WebhookSecret(redacted)")
    }
}

impl WebhookSecret {
    pub fn parse(secret: &str) -> Result<Self, SignatureError> {
        let trimmed = secret.trim();
        let encoded = trimmed.strip_prefix("whsec_").unwrap_or(trimmed);
        let key = STANDARD.decode(encoded).map_err(|_| SignatureError::InvalidSecret)?;
        if key.len() < 16 {
            return Err(SignatureError::InvalidSecret);
        }
        Ok(Self { key })
    }

    fn mac(&self, id: &str, timestamp: &str, body: &[u8]) -> Result<Hmac<Sha256>, SignatureError> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| SignatureError::InvalidSecret)?;
        mac.update(id.as_bytes());
        mac.update(b".");
        mac.update(timestamp.as_bytes());
        mac.update(b".");
        mac.update(body);
        Ok(mac)
    }

    pub fn sign(&self, id: &str, timestamp: i64, body: &[u8]) -> Result<String, SignatureError> {
        let mac = self.mac(id, &timestamp.to_string(), body)?;
        Ok(format!("v1,{}", STANDARD.encode(mac.finalize().into_bytes())))
    }

    pub fn verify(
        &self,
        id: Option<&str>,
        timestamp: Option<&str>,
        signatures: Option<&str>,
        body: &[u8],
        now_unix: i64,
    ) -> Result<(), SignatureError> {
        let (Some(id), Some(timestamp), Some(signatures)) = (id, timestamp, signatures) else {
            return Err(SignatureError::MissingHeaders);
        };
        let timestamp = timestamp.trim();
        let parsed: i64 = timestamp.parse().map_err(|_| SignatureError::InvalidTimestamp)?;
        if now_unix.abs_diff(parsed) > TOLERANCE_SECONDS {
            return Err(SignatureError::Stale);
        }
        for candidate in signatures.split_whitespace() {
            let Some(encoded) = candidate.strip_prefix("v1,") else {
                continue;
            };
            let Ok(expected) = STANDARD.decode(encoded) else {
                continue;
            };
            if self.mac(id, timestamp, body)?.verify_slice(&expected).is_ok() {
                return Ok(());
            }
        }
        Err(SignatureError::Mismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const ID: &str = "msg_p5jXN8AQM9LWM0D4loKWxJek";
    const TIMESTAMP: i64 = 1_614_265_330;
    const BODY: &[u8] = br#"{"test": 2432232314}"#;

    #[test]
    fn matches_the_standard_webhooks_reference_vector() -> Result<(), SignatureError> {
        let secret = WebhookSecret::parse(SECRET)?;
        assert_eq!(secret.sign(ID, TIMESTAMP, BODY)?, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
        secret.verify(Some(ID), Some("1614265330"), Some("v1,bm9wZQ== v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="), BODY, TIMESTAMP + 10)
    }

    #[test]
    fn rejects_tampering_staleness_and_missing_headers() -> Result<(), SignatureError> {
        let secret = WebhookSecret::parse(SECRET)?;
        let signature = secret.sign(ID, TIMESTAMP, BODY)?;
        assert_eq!(
            secret.verify(Some(ID), Some("1614265330"), Some(&signature), br#"{"test": 1}"#, TIMESTAMP),
            Err(SignatureError::Mismatch)
        );
        assert_eq!(
            secret.verify(Some("msg_other"), Some("1614265330"), Some(&signature), BODY, TIMESTAMP),
            Err(SignatureError::Mismatch)
        );
        assert_eq!(secret.verify(Some(ID), Some("1614265330"), Some(&signature), BODY, TIMESTAMP + 301), Err(SignatureError::Stale));
        assert_eq!(secret.verify(Some(ID), Some("soon"), Some(&signature), BODY, TIMESTAMP), Err(SignatureError::InvalidTimestamp));
        assert_eq!(secret.verify(None, Some("1614265330"), Some(&signature), BODY, TIMESTAMP), Err(SignatureError::MissingHeaders));
        assert_eq!(secret.verify(Some(ID), Some("1614265330"), Some("v2,abc"), BODY, TIMESTAMP), Err(SignatureError::Mismatch));
        Ok(())
    }

    #[test]
    fn rejects_short_or_malformed_secrets() {
        assert_eq!(WebhookSecret::parse("whsec_c2hvcnQ=").err(), Some(SignatureError::InvalidSecret));
        assert_eq!(WebhookSecret::parse("whsec_***").err(), Some(SignatureError::InvalidSecret));
        assert_eq!(format!("{:?}", WebhookSecret::parse(SECRET)), "Ok(WebhookSecret(redacted))");
    }
}
