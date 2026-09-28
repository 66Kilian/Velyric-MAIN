use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use redis::AsyncCommands;
use redis::aio::ConnectionManager;
use reqwest::header::CONTENT_TYPE;
use reqwest::{Method, Response, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use thiserror::Error;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tracing::warn;
use url::Url;
use uuid::Uuid;
use velyric_call_protocol::{
    AgentSnapshot, CallEventsBatch, CallUpsert, KnowledgeSearchRequest, KnowledgeSearchResponse, RoutingSnapshot, TenantOpenAiCredentials,
    ToolExecutionRequest, ToolExecutionResponse,
};
use velyric_runtime_policy::service_auth::ServiceSigner;

const AUDIENCE: &str = "control-api";
const ROUTING_STALE_GRACE: Duration = Duration::from_secs(300);
const CREDENTIALS_TTL: Duration = Duration::from_secs(60);
const MAX_CACHED_SNAPSHOTS: usize = 2_000;
const SNAPSHOT_REDIS_TTL_SECONDS: u64 = 86_400;

#[derive(Debug, Error)]
pub enum ControlApiError {
    #[error("control-api responded with HTTP {status} ({code:?})")]
    Status { status: u16, code: Option<String> },
    #[error("control-api request failed: {0}")]
    Transport(String),
    #[error("control-api response could not be decoded: {0}")]
    Decode(String),
    #[error("service token could not be signed: {0}")]
    Signing(String),
    #[error("control-api returned inconsistent data: {0}")]
    Inconsistent(String),
}

impl ControlApiError {
    #[must_use]
    pub const fn is_not_found(&self) -> bool {
        matches!(self, Self::Status { status: 404, .. })
    }

    #[must_use]
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Status { code, .. } => code.as_deref(),
            _ => None,
        }
    }
}

struct CachedRouting {
    snapshot: Arc<RoutingSnapshot>,
    fresh_until: Instant,
    stale_until: Instant,
}

struct Outgoing<'a> {
    method: Method,
    url: Url,
    scopes: &'a [&'a str],
    tenant_id: Option<Uuid>,
    trace_id: &'a str,
    idempotency_key: Option<&'a str>,
    body: Option<Vec<u8>>,
    attempts: u32,
    timeout: Duration,
}

pub struct ControlApiClient {
    http: reqwest::Client,
    base: Url,
    signer: Arc<ServiceSigner>,
    redis: Option<ConnectionManager>,
    redis_prefix: String,
    routing_cache: DashMap<(String, String), CachedRouting>,
    snapshot_cache: DashMap<Uuid, Arc<AgentSnapshot>>,
    credentials_cache: DashMap<Uuid, (TenantOpenAiCredentials, Instant)>,
}

#[must_use]
pub fn traceparent(trace_id: &str) -> String {
    format!("00-{trace_id}-{}-01", hex::encode(&Uuid::new_v4().as_bytes()[..8]))
}

async fn error_code(response: Response) -> Option<String> {
    let body: Value = response.json().await.ok()?;
    body.get("code").and_then(Value::as_str).map(str::to_owned)
}

async fn decode<T: DeserializeOwned>(response: Response) -> Result<T, ControlApiError> {
    let status = response.status();
    if !status.is_success() {
        return Err(ControlApiError::Status { status: status.as_u16(), code: error_code(response).await });
    }
    let bytes = response.bytes().await.map_err(|error| ControlApiError::Transport(error.without_url().to_string()))?;
    serde_json::from_slice(&bytes).map_err(|error| ControlApiError::Decode(error.to_string()))
}

async fn expect_success(response: Response) -> Result<(), ControlApiError> {
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(ControlApiError::Status { status: status.as_u16(), code: error_code(response).await })
    }
}

fn validate_snapshot(snapshot: &AgentSnapshot, tenant_id: Uuid, agent_version_id: Uuid) -> Result<(), ControlApiError> {
    if snapshot.tenant_id != tenant_id || snapshot.agent_version_id != agent_version_id {
        return Err(ControlApiError::Inconsistent("agent snapshot identity does not match the request".to_owned()));
    }
    snapshot.verified_config().map(|_| ()).map_err(|error| ControlApiError::Inconsistent(error.to_string()))
}

impl ControlApiClient {
    #[must_use]
    pub fn new(http: reqwest::Client, base: Url, signer: Arc<ServiceSigner>, redis: Option<ConnectionManager>, environment: &str) -> Self {
        Self {
            http,
            base,
            signer,
            redis,
            redis_prefix: format!("vly:{environment}"),
            routing_cache: DashMap::new(),
            snapshot_cache: DashMap::new(),
            credentials_cache: DashMap::new(),
        }
    }

    fn url(&self, segments: &[&str]) -> Result<Url, ControlApiError> {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|()| ControlApiError::Transport("control-api base URL cannot be a base".to_owned()))?
            .pop_if_empty()
            .extend(segments);
        Ok(url)
    }

    fn outgoing<'a>(
        method: Method,
        url: Url,
        scopes: &'a [&'a str],
        tenant_id: Option<Uuid>,
        trace_id: &'a str,
        body: Option<&impl Serialize>,
        attempts: u32,
    ) -> Result<Outgoing<'a>, ControlApiError> {
        let body = body.map(serde_json::to_vec).transpose().map_err(|error| ControlApiError::Decode(error.to_string()))?;
        Ok(Outgoing { method, url, scopes, tenant_id, trace_id, idempotency_key: None, body, attempts, timeout: Duration::from_secs(5) })
    }

    async fn send(&self, request: Outgoing<'_>) -> Result<Response, ControlApiError> {
        let mut attempt = 0_u32;
        loop {
            attempt += 1;
            let token = self
                .signer
                .sign(AUDIENCE, request.scopes, request.tenant_id, OffsetDateTime::now_utc())
                .map_err(|error| ControlApiError::Signing(error.to_string()))?;
            let mut builder = self
                .http
                .request(request.method.clone(), request.url.clone())
                .bearer_auth(token)
                .header("traceparent", traceparent(request.trace_id))
                .timeout(request.timeout);
            if let Some(key) = request.idempotency_key {
                builder = builder.header("idempotency-key", key);
            }
            if let Some(body) = &request.body {
                builder = builder.header(CONTENT_TYPE, "application/json").body(body.clone());
            }
            let error = match builder.send().await {
                Ok(response) if !(response.status().is_server_error() || response.status() == StatusCode::TOO_MANY_REQUESTS) => {
                    return Ok(response);
                }
                Ok(response) => ControlApiError::Status { status: response.status().as_u16(), code: error_code(response).await },
                Err(error) => ControlApiError::Transport(error.without_url().to_string()),
            };
            if attempt >= request.attempts {
                return Err(error);
            }
            tokio::time::sleep(Duration::from_millis(100 * 2_u64.pow(attempt.min(5)))).await;
        }
    }

    pub async fn routing(&self, provider: &str, e164: &str, trace_id: &str) -> Result<Arc<RoutingSnapshot>, ControlApiError> {
        let key = (provider.to_owned(), e164.to_owned());
        let now = Instant::now();
        let fresh = self.routing_cache.get(&key).and_then(|cached| (cached.fresh_until > now).then(|| Arc::clone(&cached.snapshot)));
        if let Some(snapshot) = fresh {
            return Ok(snapshot);
        }
        let mut url = self.url(&["internal", "v1", "runtime", "routing"])?;
        url.query_pairs_mut().append_pair("provider", provider).append_pair("e164", e164);
        let request = Self::outgoing(Method::GET, url, &["runtime.admission.read"], None, trace_id, None::<&()>, 2)?;
        let result = match self.send(request).await {
            Ok(response) => decode::<RoutingSnapshot>(response).await,
            Err(error) => Err(error),
        };
        match result {
            Ok(snapshot) => {
                let ttl = OffsetDateTime::parse(&snapshot.valid_until, &Rfc3339)
                    .ok()
                    .and_then(|until| Duration::try_from(until - OffsetDateTime::now_utc()).ok())
                    .unwrap_or(Duration::ZERO)
                    .min(Duration::from_secs(60));
                let snapshot = Arc::new(snapshot);
                self.routing_cache.insert(
                    key,
                    CachedRouting { snapshot: Arc::clone(&snapshot), fresh_until: now + ttl, stale_until: now + ROUTING_STALE_GRACE },
                );
                Ok(snapshot)
            }
            Err(error) if error.is_not_found() => {
                self.routing_cache.remove(&key);
                Err(error)
            }
            Err(error) => {
                let stale = self.routing_cache.get(&key).and_then(|cached| (cached.stale_until > now).then(|| Arc::clone(&cached.snapshot)));
                match stale {
                    Some(snapshot) => {
                        warn!(error = %error, "control-api routing unavailable; serving stale routing snapshot");
                        Ok(snapshot)
                    }
                    None => Err(error),
                }
            }
        }
    }

    fn remember(&self, snapshot: AgentSnapshot) -> Arc<AgentSnapshot> {
        if self.snapshot_cache.len() >= MAX_CACHED_SNAPSHOTS {
            let evict = self.snapshot_cache.iter().next().map(|entry| *entry.key());
            if let Some(evict) = evict {
                self.snapshot_cache.remove(&evict);
            }
        }
        let snapshot = Arc::new(snapshot);
        self.snapshot_cache.insert(snapshot.agent_version_id, Arc::clone(&snapshot));
        snapshot
    }

    pub async fn agent_snapshot(&self, tenant_id: Uuid, agent_version_id: Uuid, trace_id: &str) -> Result<Arc<AgentSnapshot>, ControlApiError> {
        let cached = self.snapshot_cache.get(&agent_version_id).map(|entry| Arc::clone(&entry));
        if let Some(snapshot) = cached {
            validate_snapshot(&snapshot, tenant_id, agent_version_id)?;
            return Ok(snapshot);
        }
        let redis_key = format!("{}:snap:agent:{tenant_id}:{agent_version_id}", self.redis_prefix);
        if let Some(redis) = &self.redis {
            let mut connection = redis.clone();
            let stored: redis::RedisResult<Option<String>> = connection.get(&redis_key).await;
            match stored {
                Ok(Some(raw)) => {
                    if let Ok(snapshot) = serde_json::from_str::<AgentSnapshot>(&raw)
                        && validate_snapshot(&snapshot, tenant_id, agent_version_id).is_ok()
                    {
                        return Ok(self.remember(snapshot));
                    }
                }
                Ok(None) => {}
                Err(error) => warn!(error = %error, "agent snapshot cache read failed"),
            }
        }
        let url = self.url(&["internal", "v1", "runtime", "agent-snapshots", &agent_version_id.to_string()])?;
        let request = Self::outgoing(Method::GET, url, &["runtime.snapshot.read"], Some(tenant_id), trace_id, None::<&()>, 3)?;
        let snapshot: AgentSnapshot = decode(self.send(request).await?).await?;
        validate_snapshot(&snapshot, tenant_id, agent_version_id)?;
        if let Some(redis) = &self.redis
            && let Ok(raw) = serde_json::to_string(&snapshot)
        {
            let mut connection = redis.clone();
            let written: redis::RedisResult<()> = connection.set_ex(&redis_key, raw, SNAPSHOT_REDIS_TTL_SECONDS).await;
            if let Err(error) = written {
                warn!(error = %error, "agent snapshot cache write failed");
            }
        }
        Ok(self.remember(snapshot))
    }

    pub async fn openai_credentials(&self, tenant_id: Uuid, trace_id: &str) -> Result<TenantOpenAiCredentials, ControlApiError> {
        let cached = self
            .credentials_cache
            .get(&tenant_id)
            .and_then(|entry| (entry.1.elapsed() < CREDENTIALS_TTL).then(|| entry.0.clone()));
        if let Some(credentials) = cached {
            return Ok(credentials);
        }
        let url = self.url(&["internal", "v1", "runtime", "tenants", &tenant_id.to_string(), "openai-credentials"])?;
        let request = Self::outgoing(Method::GET, url, &["runtime.admission.read"], Some(tenant_id), trace_id, None::<&()>, 3)?;
        let credentials: TenantOpenAiCredentials = decode(self.send(request).await?).await?;
        if credentials.tenant_id != tenant_id {
            return Err(ControlApiError::Inconsistent("credential tenant does not match the request".to_owned()));
        }
        self.credentials_cache.insert(tenant_id, (credentials.clone(), Instant::now()));
        Ok(credentials)
    }

    pub async fn upsert_call(&self, tenant_id: Uuid, call_id: Uuid, body: &CallUpsert, trace_id: &str) -> Result<(), ControlApiError> {
        let url = self.url(&["internal", "v1", "calls", &call_id.to_string()])?;
        let request = Self::outgoing(Method::PUT, url, &["call.control"], Some(tenant_id), trace_id, Some(body), 5)?;
        expect_success(self.send(request).await?).await
    }

    pub async fn post_events(&self, tenant_id: Uuid, call_id: Uuid, batch: &CallEventsBatch, trace_id: &str) -> Result<(), ControlApiError> {
        let url = self.url(&["internal", "v1", "calls", &call_id.to_string(), "events"])?;
        let request = Self::outgoing(Method::POST, url, &["call.control"], Some(tenant_id), trace_id, Some(batch), 5)?;
        expect_success(self.send(request).await?).await
    }

    pub async fn search_knowledge(&self, tenant_id: Uuid, body: &KnowledgeSearchRequest, trace_id: &str) -> Result<KnowledgeSearchResponse, ControlApiError> {
        let url = self.url(&["internal", "v1", "knowledge", "search"])?;
        let mut request = Self::outgoing(Method::POST, url, &["knowledge.retrieve"], Some(tenant_id), trace_id, Some(body), 2)?;
        request.timeout = Duration::from_millis(2500);
        decode(self.send(request).await?).await
    }

    pub async fn execute_tool(
        &self,
        tenant_id: Uuid,
        idempotency_key: &str,
        body: &ToolExecutionRequest,
        trace_id: &str,
        timeout: Duration,
    ) -> Result<ToolExecutionResponse, ControlApiError> {
        let url = self.url(&["internal", "v1", "tool-gateway", "executions"])?;
        let mut request = Self::outgoing(Method::POST, url, &["tool.execute"], Some(tenant_id), trace_id, Some(body), 3)?;
        request.idempotency_key = Some(idempotency_key);
        request.timeout = timeout;
        decode(self.send(request).await?).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{TestKeys, agent_snapshot, routing_snapshot};
    use serde_json::json;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    async fn client(server: &MockServer, keys: &TestKeys) -> Result<ControlApiClient, Box<dyn std::error::Error>> {
        crate::install_crypto_provider();
        Ok(ControlApiClient::new(reqwest::Client::builder().build()?, Url::parse(&server.uri())?, Arc::new(keys.signer("voice-runtime")?), None, "ci"))
    }

    #[tokio::test]
    async fn routing_is_cached_until_valid_until_and_served_stale_when_control_api_fails() -> TestResult {
        let server = MockServer::start().await;
        let keys = TestKeys::new(7)?;
        let tenant = Uuid::now_v7();
        let mut routing = routing_snapshot(tenant, Uuid::now_v7());
        routing.valid_until = "2000-01-01T00:00:00Z".into();
        Mock::given(method("GET"))
            .and(path("/internal/v1/runtime/routing"))
            .and(query_param("provider", "telnyx"))
            .and(query_param("e164", "+3612345678"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&routing))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/internal/v1/runtime/routing"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({"code":"SERVICE_UNAVAILABLE"})))
            .mount(&server)
            .await;
        let client = client(&server, &keys).await?;
        let first = client.routing("telnyx", "+3612345678", "4bf92f3577b34da6a3ce929d0e0e4736").await?;
        let second = client.routing("telnyx", "+3612345678", "4bf92f3577b34da6a3ce929d0e0e4736").await?;
        assert_eq!(first.tenant_id, tenant);
        assert!(Arc::ptr_eq(&first, &second));
        let token = server
            .received_requests()
            .await
            .and_then(|requests| requests.first().and_then(|request| request.headers.get("authorization").cloned()))
            .ok_or("missing authorization header")?;
        let verified = keys.verifier("control-api")?.verify(token.to_str()?.trim_start_matches("Bearer "), &["runtime.admission.read"])?;
        assert_eq!(verified.issuer, "voice-runtime");
        assert_eq!(verified.tenant_id, None);
        let missing = client.routing("telnyx", "+3699999999", "4bf92f3577b34da6a3ce929d0e0e4736").await;
        assert!(matches!(missing, Err(ControlApiError::Status { status: 503, .. })));
        Ok(())
    }

    #[tokio::test]
    async fn agent_snapshots_are_hash_verified_tenant_bound_and_cached() -> TestResult {
        let server = MockServer::start().await;
        let keys = TestKeys::new(8)?;
        let tenant = Uuid::now_v7();
        let snapshot = agent_snapshot(tenant, Uuid::now_v7());
        let mut tampered = agent_snapshot(tenant, Uuid::now_v7());
        tampered.config["voice"] = json!("alloy");
        Mock::given(method("GET"))
            .and(path(format!("/internal/v1/runtime/agent-snapshots/{}", snapshot.agent_version_id)))
            .respond_with(ResponseTemplate::new(200).set_body_json(&snapshot))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/internal/v1/runtime/agent-snapshots/{}", tampered.agent_version_id)))
            .respond_with(ResponseTemplate::new(200).set_body_json(&tampered))
            .mount(&server)
            .await;
        let client = client(&server, &keys).await?;
        let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
        let fetched = client.agent_snapshot(tenant, snapshot.agent_version_id, trace).await?;
        let again = client.agent_snapshot(tenant, snapshot.agent_version_id, trace).await?;
        assert!(Arc::ptr_eq(&fetched, &again));
        assert!(matches!(
            client.agent_snapshot(Uuid::now_v7(), snapshot.agent_version_id, trace).await,
            Err(ControlApiError::Inconsistent(_))
        ));
        assert!(matches!(
            client.agent_snapshot(tenant, tampered.agent_version_id, trace).await,
            Err(ControlApiError::Inconsistent(_))
        ));
        Ok(())
    }

    #[tokio::test]
    async fn tool_executions_carry_the_idempotency_key_and_a_tenant_bound_token() -> TestResult {
        let server = MockServer::start().await;
        let keys = TestKeys::new(9)?;
        let tenant = Uuid::now_v7();
        let run = Uuid::now_v7();
        Mock::given(method("POST"))
            .and(path("/internal/v1/tool-gateway/executions"))
            .and(header("idempotency-key", "0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e5f:call_1"))
            .respond_with(ResponseTemplate::new(500))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/internal/v1/tool-gateway/executions"))
            .and(header("idempotency-key", "0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e5f:call_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "tool_run_id": run, "status": "SUCCEEDED", "result": {"slots": []}, "error_code": null, "retryable": false, "replayed": true
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = client(&server, &keys).await?;
        let request = ToolExecutionRequest {
            tenant_id: tenant,
            call_id: Some(Uuid::now_v7()),
            agent_version_id: Uuid::now_v7(),
            specialist: "BOOKING".into(),
            tool_name: "lookup_availability".into(),
            arguments: serde_json::Map::new(),
            conversation_state: "DISCOVERY".into(),
            confirmation: None,
            verified_identity: false,
            trace_id: Some("4bf92f3577b34da6a3ce929d0e0e4736".into()),
        };
        let response = client
            .execute_tool(tenant, "0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e5f:call_1", &request, "4bf92f3577b34da6a3ce929d0e0e4736", Duration::from_secs(5))
            .await?;
        assert_eq!(response.tool_run_id, run);
        assert!(response.replayed);
        let requests = server.received_requests().await.ok_or("no requests recorded")?;
        assert_eq!(requests.len(), 2);
        let tokens: Vec<String> = requests
            .iter()
            .filter_map(|request| request.headers.get("authorization").and_then(|value| value.to_str().ok()).map(str::to_owned))
            .collect();
        assert_eq!(tokens.len(), 2);
        assert_ne!(tokens.first(), tokens.get(1));
        let verifier = keys.verifier("control-api")?;
        for token in tokens {
            let verified = verifier.verify(token.trim_start_matches("Bearer "), &["tool.execute"])?;
            assert_eq!(verified.tenant_id, Some(tenant));
        }
        Ok(())
    }
}
