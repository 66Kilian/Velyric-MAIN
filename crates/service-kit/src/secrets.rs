use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use secrecy::SecretString;
use thiserror::Error;
use tokio::sync::OnceCell;

use crate::env::SecretSource;

pub type SharedSecret = Arc<SecretString>;

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("tenant secret references cannot be resolved in simulator mode")]
    RemoteDisabled,
    #[error("secret {0} could not be resolved: {1}")]
    Resolve(String, String),
    #[error("secret {0} has no string value")]
    Empty(String),
    #[error("secret reference {0} is not resolvable by this service")]
    UnsupportedReference(String),
}

pub struct SecretResolver {
    region: String,
    allow_remote_references: bool,
    client: OnceCell<aws_sdk_secretsmanager::Client>,
    cache: DashMap<String, (SharedSecret, Instant)>,
    ttl: Duration,
}

impl SecretResolver {
    #[must_use]
    pub fn new(region: &str, allow_remote_references: bool) -> Self {
        Self {
            region: region.to_owned(),
            allow_remote_references,
            client: OnceCell::new(),
            cache: DashMap::new(),
            ttl: Duration::from_secs(300),
        }
    }

    async fn client(&self) -> &aws_sdk_secretsmanager::Client {
        self.client
            .get_or_init(|| async {
                let http_client = aws_smithy_http_client::Builder::new()
                    .tls_provider(aws_smithy_http_client::tls::Provider::Rustls(aws_smithy_http_client::tls::rustls_provider::CryptoMode::Ring))
                    .build_https();
                let shared = aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .region(aws_config::Region::new(self.region.clone()))
                    .http_client(http_client)
                    .load()
                    .await;
                aws_sdk_secretsmanager::Client::new(&shared)
            })
            .await
    }

    pub async fn resolve(&self, source: &SecretSource) -> Result<SharedSecret, SecretError> {
        match source {
            SecretSource::Inline(value) => Ok(Arc::new(SecretString::from(value.clone()))),
            SecretSource::Arn(arn) => self.fetch(arn).await,
        }
    }

    pub async fn resolve_reference(&self, secret_ref: &str) -> Result<SharedSecret, SecretError> {
        if !self.allow_remote_references {
            return Err(SecretError::RemoteDisabled);
        }
        let id = secret_ref.strip_prefix("aws-sm://").ok_or_else(|| SecretError::UnsupportedReference(secret_ref.to_owned()))?;
        self.fetch(id).await
    }

    async fn fetch(&self, id: &str) -> Result<SharedSecret, SecretError> {
        let cached = self.cache.get(id).and_then(|entry| (entry.1.elapsed() < self.ttl).then(|| Arc::clone(&entry.0)));
        if let Some(secret) = cached {
            return Ok(secret);
        }
        let output = self
            .client()
            .await
            .get_secret_value()
            .secret_id(id)
            .send()
            .await
            .map_err(|error| SecretError::Resolve(id.to_owned(), aws_sdk_secretsmanager::error::DisplayErrorContext(&error).to_string()))?;
        let value = output.secret_string().filter(|value| !value.is_empty()).ok_or_else(|| SecretError::Empty(id.to_owned()))?;
        let secret = Arc::new(SecretString::from(value.to_owned()));
        self.cache.insert(id.to_owned(), (Arc::clone(&secret), Instant::now()));
        Ok(secret)
    }

    pub fn invalidate(&self, id: &str) {
        self.cache.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::ExposeSecret;

    #[tokio::test]
    async fn inline_secrets_resolve_locally_and_remote_references_respect_the_mode() -> Result<(), SecretError> {
        let resolver = SecretResolver::new("eu-central-1", false);
        let secret = resolver.resolve(&SecretSource::Inline("whsec_abc".into())).await?;
        assert_eq!(secret.expose_secret(), "whsec_abc");
        assert!(matches!(resolver.resolve_reference("aws-sm://tenants/0192/openai-service-account-key/v1").await, Err(SecretError::RemoteDisabled)));
        let remote = SecretResolver::new("eu-central-1", true);
        assert!(matches!(
            remote.resolve_reference("local-vault://tenants/0192/openai-service-account-key/v1").await,
            Err(SecretError::UnsupportedReference(_))
        ));
        Ok(())
    }
}
