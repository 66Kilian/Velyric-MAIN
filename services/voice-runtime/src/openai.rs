use std::time::Duration;

use http::HeaderValue;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;

use crate::sip::SipHeader;

pub type SidebandStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Error)]
pub enum OpenAiError {
    #[error("OpenAI session id is invalid")]
    InvalidSessionId,
    #[error("OpenAI base URL is invalid: {0}")]
    InvalidBaseUrl(&'static str),
    #[error("OpenAI responded with HTTP {status} ({code})")]
    Status { status: u16, code: String },
    #[error("OpenAI request failed: {0}")]
    Transport(String),
    #[error("OpenAI sideband connection failed: {0}")]
    Sideband(String),
}

impl OpenAiError {
    #[must_use]
    pub const fn retryable(&self) -> bool {
        match self {
            Self::Status { status, .. } => *status >= 500 || *status == 429,
            Self::Transport(_) | Self::Sideband(_) => true,
            Self::InvalidSessionId | Self::InvalidBaseUrl(_) => false,
        }
    }
}

#[must_use]
pub fn valid_session_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AcceptRequest {
    pub session: AcceptSession,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AcceptSession {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub model: String,
    pub instructions: String,
    pub audio: AudioConfig,
    pub delegation: Delegation,
    pub store: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AudioConfig {
    pub output: AudioOutput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AudioOutput {
    pub voice: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Delegation {
    Client,
    Responses { responses: ResponsesDelegation },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResponsesDelegation {
    pub model: String,
    pub instructions: String,
    pub max_output_tokens: u32,
    pub parallel_tool_calls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Reasoning>,
    pub tool_choice: &'static str,
    pub tools: Vec<FunctionTool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reasoning {
    pub effort: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FunctionTool {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum ClientEvent {
    #[serde(rename = "session.instructions.append")]
    InstructionsAppend { content: String, delegation_id: Option<String>, event_id: String },
    #[serde(rename = "session.commentary.append")]
    CommentaryAppend { content: String, delegation_id: Option<String>, event_id: String },
    #[serde(rename = "response.item.create")]
    ResponseItemCreate { item: Value, event_id: String },
    #[serde(rename = "response.create")]
    ResponseCreate { event_id: String },
    #[serde(rename = "session.close")]
    SessionClose { event_id: String },
}

#[must_use]
pub fn client_event_id() -> String {
    format!("evt_{}", uuid::Uuid::now_v7().simple())
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SessionInfo {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DelegationInfo {
    pub id: String,
    pub target: String,
    #[serde(default)]
    pub response_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct UsageInfo {
    pub seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ErrorInfo {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub enum ServerEvent {
    #[serde(rename = "session.started")]
    SessionStarted { session: SessionInfo },
    #[serde(rename = "session.input_transcript.delta")]
    InputTranscriptDelta { delta: String, start_ms: f64, end_ms: f64 },
    #[serde(rename = "session.output_transcript.delta")]
    OutputTranscriptDelta { delta: String, start_ms: f64, end_ms: f64 },
    #[serde(rename = "session.delegation.created")]
    DelegationCreated { delegation: DelegationInfo },
    #[serde(rename = "response.event")]
    ResponseEvent {
        event: Value,
        #[serde(default)]
        delegation_id: Option<String>,
    },
    #[serde(rename = "session.usage.updated")]
    UsageUpdated { usage: UsageInfo },
    #[serde(rename = "transport.dtmf.received")]
    DtmfReceived { event: String },
    #[serde(rename = "transport.failed")]
    TransportFailed { error: ErrorInfo },
    #[serde(rename = "session.closed")]
    Closed {
        reason: String,
        #[serde(default)]
        usage: Option<UsageInfo>,
    },
    #[serde(rename = "error")]
    Error { error: ErrorInfo },
    #[serde(other)]
    Unknown,
}

#[must_use]
pub fn milliseconds(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 { value.round() as u64 } else { 0 }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DelegatedResponseEvent {
    FunctionCall { call_id: String, name: String, arguments: String },
    Completed { model: Option<String>, input_tokens: u64, output_tokens: u64 },
    Failed { code: Option<String> },
    Other,
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

#[must_use]
pub fn classify_response_event(event: &Value) -> DelegatedResponseEvent {
    match event.get("type").and_then(Value::as_str).unwrap_or_default() {
        "response.output_item.done" => {
            let Some(item) = event.get("item").filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call")) else {
                return DelegatedResponseEvent::Other;
            };
            match (string_field(item, "call_id"), string_field(item, "name"), string_field(item, "arguments")) {
                (Some(call_id), Some(name), Some(arguments)) => DelegatedResponseEvent::FunctionCall { call_id, name, arguments },
                _ => DelegatedResponseEvent::Other,
            }
        }
        "response.completed" | "response.incomplete" => {
            let response = event.get("response").unwrap_or(&Value::Null);
            let tokens = |key: &str| response.pointer(&format!("/usage/{key}")).and_then(Value::as_u64).unwrap_or(0);
            DelegatedResponseEvent::Completed {
                model: string_field(response, "model"),
                input_tokens: tokens("input_tokens"),
                output_tokens: tokens("output_tokens"),
            }
        }
        "response.failed" => DelegatedResponseEvent::Failed {
            code: event.pointer("/response/error/code").and_then(Value::as_str).map(str::to_owned),
        },
        _ => DelegatedResponseEvent::Other,
    }
}

#[must_use]
pub fn function_call_output(call_id: &str, output: &Value) -> Value {
    json!({ "type": "function_call_output", "call_id": call_id, "output": output.to_string() })
}

#[derive(Debug, Clone, Deserialize)]
pub struct WebhookEnvelope {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct IncomingCallData {
    pub session_id: String,
    #[serde(default)]
    pub sip_headers: Vec<SipHeader>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Embedding {
    pub vector: Vec<f32>,
    pub tokens: u64,
}

#[derive(Deserialize)]
struct EmbeddingItem {
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct EmbeddingUsage {
    prompt_tokens: u64,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingItem>,
    usage: Option<EmbeddingUsage>,
}

pub struct OpenAiLiveClient {
    http: reqwest::Client,
    api_base: Url,
    sideband_base: Url,
}

fn websocket_base(api_base: &Url) -> Result<Url, OpenAiError> {
    let scheme = match api_base.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => return Err(OpenAiError::InvalidBaseUrl("unsupported scheme")),
    };
    let mut url = api_base.clone();
    url.set_scheme(scheme).map_err(|()| OpenAiError::InvalidBaseUrl("scheme cannot be changed"))?;
    Ok(url)
}

fn session_url(base: &Url, session_id: &str, action: &str) -> Result<Url, OpenAiError> {
    if !valid_session_id(session_id) {
        return Err(OpenAiError::InvalidSessionId);
    }
    let mut url = base.clone();
    url.path_segments_mut()
        .map_err(|()| OpenAiError::InvalidBaseUrl("cannot be a base"))?
        .pop_if_empty()
        .extend(["live", "sessions", session_id, action]);
    Ok(url)
}

async fn error_code(response: reqwest::Response) -> String {
    let body: Option<Value> = response.json().await.ok();
    body.as_ref()
        .and_then(|value| value.pointer("/error/code").or_else(|| value.pointer("/error/type")))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .chars()
        .take(80)
        .collect()
}

impl OpenAiLiveClient {
    pub fn new(http: reqwest::Client, api_base: Url) -> Result<Self, OpenAiError> {
        let sideband_base = websocket_base(&api_base)?;
        Ok(Self { http, api_base, sideband_base })
    }

    #[must_use]
    pub fn with_sideband_base(mut self, sideband_base: Url) -> Self {
        self.sideband_base = sideband_base;
        self
    }

    async fn post(&self, api_key: &SecretString, session_id: &str, action: &str, body: Option<Value>, attempts: u32) -> Result<(), OpenAiError> {
        let url = session_url(&self.api_base, session_id, action)?;
        let mut attempt = 0_u32;
        loop {
            attempt += 1;
            let mut request = self.http.post(url.clone()).bearer_auth(api_key.expose_secret()).timeout(Duration::from_secs(10));
            if let Some(body) = &body {
                request = request.json(body);
            }
            let error = match request.send().await {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) => OpenAiError::Status { status: response.status().as_u16(), code: error_code(response).await },
                Err(error) => OpenAiError::Transport(error.without_url().to_string()),
            };
            if !error.retryable() || attempt >= attempts {
                return Err(error);
            }
            tokio::time::sleep(Duration::from_millis(150 * u64::from(attempt))).await;
        }
    }

    pub async fn embed(&self, api_key: &SecretString, model: &str, dimensions: usize, input: &str) -> Result<Embedding, OpenAiError> {
        let mut url = self.api_base.clone();
        url.path_segments_mut().map_err(|()| OpenAiError::InvalidBaseUrl("cannot be a base"))?.pop_if_empty().push("embeddings");
        let response = self
            .http
            .post(url)
            .bearer_auth(api_key.expose_secret())
            .timeout(Duration::from_millis(1500))
            .json(&json!({ "model": model, "input": input, "dimensions": dimensions, "encoding_format": "float" }))
            .send()
            .await
            .map_err(|error| OpenAiError::Transport(error.without_url().to_string()))?;
        if !response.status().is_success() {
            return Err(OpenAiError::Status { status: response.status().as_u16(), code: error_code(response).await });
        }
        let body: EmbeddingResponse = response.json().await.map_err(|error| OpenAiError::Transport(error.without_url().to_string()))?;
        let vector = body.data.into_iter().next().map(|item| item.embedding).unwrap_or_default();
        if vector.len() != dimensions {
            return Err(OpenAiError::Transport("embedding response has unexpected dimensions".to_owned()));
        }
        Ok(Embedding { vector, tokens: body.usage.map_or(0, |usage| usage.prompt_tokens) })
    }

    pub async fn accept(&self, api_key: &SecretString, session_id: &str, request: &AcceptRequest) -> Result<(), OpenAiError> {
        let body = serde_json::to_value(request).map_err(|error| OpenAiError::Transport(error.to_string()))?;
        self.post(api_key, session_id, "accept", Some(body), 2).await
    }

    pub async fn reject(&self, api_key: &SecretString, session_id: &str, status_code: u16) -> Result<(), OpenAiError> {
        self.post(api_key, session_id, "reject", Some(json!({ "status_code": status_code })), 3).await
    }

    pub async fn refer(&self, api_key: &SecretString, session_id: &str, target_uri: &str) -> Result<(), OpenAiError> {
        self.post(api_key, session_id, "refer", Some(json!({ "target_uri": target_uri })), 3).await
    }

    pub async fn hangup(&self, api_key: &SecretString, session_id: &str) -> Result<(), OpenAiError> {
        self.post(api_key, session_id, "hangup", None, 3).await
    }

    pub async fn attach(&self, api_key: &SecretString, session_id: &str) -> Result<SidebandStream, OpenAiError> {
        let url = session_url(&self.sideband_base, session_id, "attach")?;
        let mut request = url.as_str().into_client_request().map_err(|error| OpenAiError::Sideband(error.to_string()))?;
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", api_key.expose_secret()))
            .map_err(|_| OpenAiError::Sideband("API key is not a valid header value".to_owned()))?;
        authorization.set_sensitive(true);
        request.headers_mut().insert(http::header::AUTHORIZATION, authorization);
        let (stream, _) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(request))
            .await
            .map_err(|_| OpenAiError::Sideband("attach timed out".to_owned()))?
            .map_err(|error| OpenAiError::Sideband(error.to_string()))?;
        Ok(stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use wiremock::matchers::{body_json, body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn parses_live_server_events_and_ignores_unknown_ones() -> TestResult {
        let delegation: ServerEvent = serde_json::from_str(
            r#"{"type":"session.delegation.created","event_id":"e1","offset_ms":10,"delegation":{"id":"del_1","target":"responses","type":"delegation","response_id":"resp_1"}}"#,
        )?;
        assert_eq!(
            delegation,
            ServerEvent::DelegationCreated {
                delegation: DelegationInfo { id: "del_1".into(), target: "responses".into(), response_id: Some("resp_1".into()) }
            }
        );
        let closed: ServerEvent = serde_json::from_str(
            r#"{"type":"session.closed","event_id":"e2","reason":"remote_hangup","session":{"id":"sess_1"},"usage":{"seconds":61.5}}"#,
        )?;
        assert_eq!(closed, ServerEvent::Closed { reason: "remote_hangup".into(), usage: Some(UsageInfo { seconds: 61.5 }) });
        let unknown: ServerEvent = serde_json::from_str(r#"{"type":"session.thinking.appended","event_id":"e3","start_ms":1}"#)?;
        assert_eq!(unknown, ServerEvent::Unknown);
        let dtmf: ServerEvent = serde_json::from_str(r##"{"type":"transport.dtmf.received","event_id":"e4","event":"#"}"##)?;
        assert_eq!(dtmf, ServerEvent::DtmfReceived { event: "#".into() });
        Ok(())
    }

    #[test]
    fn classifies_delegated_responses_events() {
        let call = json!({"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup_availability","arguments":"{\"date\":\"2026-09-15\"}"}});
        assert_eq!(
            classify_response_event(&call),
            DelegatedResponseEvent::FunctionCall {
                call_id: "call_1".into(),
                name: "lookup_availability".into(),
                arguments: "{\"date\":\"2026-09-15\"}".into()
            }
        );
        let completed = json!({"type":"response.completed","response":{"model":"gpt-5.6-luna","usage":{"input_tokens":1200,"output_tokens":80}}});
        assert_eq!(
            classify_response_event(&completed),
            DelegatedResponseEvent::Completed { model: Some("gpt-5.6-luna".into()), input_tokens: 1200, output_tokens: 80 }
        );
        let message = json!({"type":"response.output_item.done","item":{"type":"message"}});
        assert_eq!(classify_response_event(&message), DelegatedResponseEvent::Other);
        assert_eq!(
            function_call_output("call_1", &json!({"status":"SUCCEEDED"})),
            json!({"type":"function_call_output","call_id":"call_1","output":"{\"status\":\"SUCCEEDED\"}"})
        );
    }

    #[test]
    fn serializes_client_events_with_nullable_delegation_ids() -> TestResult {
        let event = ClientEvent::CommentaryAppend { content: "Egy pillanat.".into(), delegation_id: None, event_id: "evt_1".into() };
        assert_eq!(
            serde_json::to_value(&event)?,
            json!({"type":"session.commentary.append","content":"Egy pillanat.","delegation_id":null,"event_id":"evt_1"})
        );
        assert_eq!(serde_json::to_value(&Delegation::Client)?, json!({"type":"client"}));
        Ok(())
    }

    #[tokio::test]
    async fn session_actions_use_bearer_auth_and_retry_only_transient_failures() -> TestResult {
        crate::install_crypto_provider();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/live/sessions/sess_123/accept"))
            .and(header("authorization", "Bearer sk-test"))
            .and(body_partial_json(json!({"session":{"type":"live","model":"gpt-live-1","delegation":{"type":"responses"}}})))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/live/sessions/sess_123/refer"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/live/sessions/sess_123/refer"))
            .and(body_json(json!({"target_uri":"tel:+3612345678"})))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/live/sessions/sess_123/hangup"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error":{"code":"session_not_found","message":"x"}})))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenAiLiveClient::new(reqwest::Client::builder().build()?, Url::parse(&format!("{}/v1", server.uri()))?)?;
        let key = SecretString::from("sk-test".to_owned());
        let request = AcceptRequest {
            session: AcceptSession {
                kind: "live",
                model: "gpt-live-1".into(),
                instructions: "Be brief.".into(),
                audio: AudioConfig { output: AudioOutput { voice: "marin".into() } },
                delegation: Delegation::Responses {
                    responses: ResponsesDelegation {
                        model: "gpt-5.6-luna".into(),
                        instructions: "Use tools.".into(),
                        max_output_tokens: 512,
                        parallel_tool_calls: false,
                        reasoning: None,
                        tool_choice: "auto",
                        tools: vec![],
                    },
                },
                store: false,
            },
        };
        client.accept(&key, "sess_123", &request).await?;
        client.refer(&key, "sess_123", "tel:+3612345678").await?;
        let hangup = client.hangup(&key, "sess_123").await;
        assert!(matches!(hangup, Err(OpenAiError::Status { status: 404, ref code }) if code == "session_not_found"));
        assert!(matches!(client.hangup(&key, "../admin").await, Err(OpenAiError::InvalidSessionId)));
        Ok(())
    }
}
