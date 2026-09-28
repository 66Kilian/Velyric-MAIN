use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use futures_util::StreamExt;
use redis::aio::ConnectionManager;
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use tracing::warn;
use uuid::Uuid;
use velyric_call_protocol::{RuntimeCommand, RuntimeCommandReply};
use velyric_runtime_policy::service_auth::{ServiceAuthError, ServiceVerifier};

use crate::metrics::Metrics;
use crate::registry::{Registry, SessionCommand};

pub const SUBJECT: &str = "runtime.v1.cmd.*.*";
const AUDIENCE_SCOPE: &str = "call.control";

fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX))
}

pub struct ReplayGuard {
    redis: Option<ConnectionManager>,
    prefix: String,
    local: DashMap<String, i64>,
}

impl ReplayGuard {
    #[must_use]
    pub fn new(redis: Option<ConnectionManager>, environment: &str) -> Self {
        Self { redis, prefix: format!("vly:{environment}"), local: DashMap::new() }
    }

    pub async fn first_use(&self, issuer: &str, jti: Uuid, expires_at: i64) -> bool {
        let now = unix_now();
        let key = format!("{}:jti:{issuer}:{jti}", self.prefix);
        let ttl = u64::try_from(expires_at.saturating_sub(now)).unwrap_or(0).max(1) + 30;
        if self.local.len() > 50_000 {
            self.local.retain(|_, expiry| *expiry > now);
        }
        match self.local.entry(key.clone()) {
            Entry::Occupied(_) => return false,
            Entry::Vacant(vacant) => {
                vacant.insert(now.saturating_add(i64::try_from(ttl).unwrap_or(i64::MAX)));
            }
        }
        let Some(redis) = &self.redis else {
            return true;
        };
        let mut connection = redis.clone();
        let stored: redis::RedisResult<Option<String>> =
            redis::cmd("SET").arg(&key).arg("1").arg("NX").arg("EX").arg(ttl).query_async(&mut connection).await;
        match stored {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                warn!(error = %error, "distributed replay guard unavailable; relying on the per-instance cache");
                true
            }
        }
    }
}

pub struct CommandContext {
    pub registry: Arc<Registry>,
    pub verifier: watch::Receiver<Arc<ServiceVerifier>>,
    pub replay: ReplayGuard,
    pub metrics: Arc<Metrics>,
}

fn rejection(state: &str, code: &str) -> RuntimeCommandReply {
    RuntimeCommandReply { accepted: false, state: state.to_owned(), error_code: Some(code.to_owned()) }
}

#[must_use]
pub fn parse_subject(subject: &str) -> Option<(Uuid, Uuid)> {
    let rest = subject.strip_prefix("runtime.v1.cmd.")?;
    let (tenant, call) = rest.split_once('.')?;
    Some((Uuid::parse_str(tenant).ok()?, Uuid::parse_str(call).ok()?))
}

pub async fn process(context: &CommandContext, subject: &str, authorization: Option<&str>, payload: &[u8]) -> Option<RuntimeCommandReply> {
    let (tenant_id, call_id) = parse_subject(subject)?;
    let sender = context.registry.lookup(tenant_id, call_id)?;
    let Some(token) = authorization.and_then(|value| value.strip_prefix("Bearer ")) else {
        return Some(rejection("UNKNOWN", "UNAUTHENTICATED"));
    };
    let verifier = Arc::clone(&context.verifier.borrow());
    let verified = match verifier.verify(token, &[AUDIENCE_SCOPE]) {
        Ok(verified) => verified,
        Err(ServiceAuthError::MissingScopes(_)) => return Some(rejection("UNKNOWN", "SERVICE_SCOPE_MISSING")),
        Err(_) => return Some(rejection("UNKNOWN", "SERVICE_TOKEN_INVALID")),
    };
    if verified.tenant_id != Some(tenant_id) {
        return Some(rejection("UNKNOWN", "FORBIDDEN"));
    }
    if !context.replay.first_use(&verified.issuer, verified.jti, verified.expires_at).await {
        return Some(rejection("UNKNOWN", "SERVICE_TOKEN_INVALID"));
    }
    let Ok(command) = serde_json::from_slice::<RuntimeCommand>(payload) else {
        return Some(rejection("UNKNOWN", "VALIDATION_FAILED"));
    };
    let command_call = match &command {
        RuntimeCommand::Transfer { call_id, .. } | RuntimeCommand::Terminate { call_id, .. } => *call_id,
    };
    if command_call != call_id {
        return Some(rejection("UNKNOWN", "VALIDATION_FAILED"));
    }
    let (reply, receiver) = oneshot::channel();
    if sender.send(SessionCommand::Runtime { command, reply }).await.is_err() {
        return Some(rejection("ENDED", "NOT_FOUND"));
    }
    match tokio::time::timeout(Duration::from_secs(4), receiver).await {
        Ok(Ok(result)) => Some(result),
        _ => Some(rejection("UNKNOWN", "SERVICE_UNAVAILABLE")),
    }
}

pub async fn serve(client: async_nats::Client, context: Arc<CommandContext>, shutdown: CancellationToken) -> Result<(), async_nats::SubscribeError> {
    let mut subscriber = client.subscribe(SUBJECT).await?;
    loop {
        let message = tokio::select! {
            message = subscriber.next() => message,
            () = shutdown.cancelled() => None,
        };
        let Some(message) = message else {
            break;
        };
        let Some(reply_subject) = message.reply.clone() else {
            continue;
        };
        let context = Arc::clone(&context);
        let client = client.clone();
        tokio::spawn(async move {
            let authorization = message.headers.as_ref().and_then(|headers| headers.get("authorization")).map(|value| value.as_str().to_owned());
            let Some(result) = process(&context, message.subject.as_str(), authorization.as_deref(), &message.payload).await else {
                return;
            };
            let label = if result.accepted { "accepted" } else { result.error_code.as_deref().unwrap_or("rejected") };
            context.metrics.increment("runtime_commands", "result", label);
            match serde_json::to_vec(&result) {
                Ok(body) => {
                    if let Err(error) = client.publish(reply_subject, body.into()).await {
                        warn!(error = %error, "runtime command reply could not be published");
                    }
                }
                Err(error) => warn!(error = %error, "runtime command reply could not be serialized"),
            }
        });
    }
    if let Err(error) = subscriber.unsubscribe().await {
        warn!(error = %error, "runtime command subscription could not be closed cleanly");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::SessionHandle;
    use crate::test_support::TestKeys;
    use serde_json::json;
    use time::OffsetDateTime;
    use tokio::sync::mpsc;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn parses_only_well_formed_command_subjects() {
        let tenant = Uuid::from_u128(1);
        let call = Uuid::from_u128(2);
        assert_eq!(parse_subject(&format!("runtime.v1.cmd.{tenant}.{call}")), Some((tenant, call)));
        assert_eq!(parse_subject(&format!("runtime.v1.cmd.{tenant}")), None);
        assert_eq!(parse_subject(&format!("runtime.v2.cmd.{tenant}.{call}")), None);
        assert_eq!(parse_subject("runtime.v1.cmd.x.y"), None);
    }

    #[tokio::test]
    async fn commands_require_a_fresh_tenant_bound_call_control_token() -> TestResult {
        let keys = TestKeys::new(31)?;
        let signer = keys.signer("control-api")?;
        let (_verifier_sender, verifier) = watch::channel(Arc::new(keys.verifier("voice-runtime")?));
        let registry = Arc::new(Registry::default());
        let tenant = Uuid::now_v7();
        let call = Uuid::now_v7();
        let (commands, mut receiver) = mpsc::channel(4);
        registry.insert(call, SessionHandle { tenant_id: tenant, commands });
        tokio::spawn(async move {
            while let Some(SessionCommand::Runtime { reply, .. }) = receiver.recv().await {
                let _ = reply.send(RuntimeCommandReply { accepted: true, state: "TERMINATING".into(), error_code: None });
            }
        });
        let context = CommandContext { registry, verifier, replay: ReplayGuard::new(None, "ci"), metrics: Arc::new(Metrics::new(crate::METRICS_PREFIX)) };
        let subject = format!("runtime.v1.cmd.{tenant}.{call}");
        let payload = json!({ "type": "TERMINATE", "call_id": call, "reason": "operator", "requested_by": "user-1" }).to_string();
        let now = OffsetDateTime::now_utc();
        let token = format!("Bearer {}", signer.sign("voice-runtime", &["call.control"], Some(tenant), now)?);

        let accepted = process(&context, &subject, Some(&token), payload.as_bytes()).await.ok_or("expected a reply")?;
        assert!(accepted.accepted);
        let replayed = process(&context, &subject, Some(&token), payload.as_bytes()).await.ok_or("expected a reply")?;
        assert_eq!(replayed.error_code.as_deref(), Some("SERVICE_TOKEN_INVALID"));

        let foreign = format!("Bearer {}", signer.sign("voice-runtime", &["call.control"], Some(Uuid::now_v7()), now)?);
        assert_eq!(process(&context, &subject, Some(&foreign), payload.as_bytes()).await.and_then(|reply| reply.error_code).as_deref(), Some("FORBIDDEN"));

        let unscoped = format!("Bearer {}", signer.sign("voice-runtime", &["tool.execute"], Some(tenant), now)?);
        assert_eq!(
            process(&context, &subject, Some(&unscoped), payload.as_bytes()).await.and_then(|reply| reply.error_code).as_deref(),
            Some("SERVICE_SCOPE_MISSING")
        );

        let wrong_audience = format!("Bearer {}", signer.sign("control-api", &["call.control"], Some(tenant), now)?);
        assert_eq!(
            process(&context, &subject, Some(&wrong_audience), payload.as_bytes()).await.and_then(|reply| reply.error_code).as_deref(),
            Some("SERVICE_TOKEN_INVALID")
        );

        let other_call = json!({ "type": "TERMINATE", "call_id": Uuid::now_v7(), "reason": "operator", "requested_by": "user-1" }).to_string();
        let fresh = format!("Bearer {}", signer.sign("voice-runtime", &["call.control"], Some(tenant), now)?);
        assert_eq!(
            process(&context, &subject, Some(&fresh), other_call.as_bytes()).await.and_then(|reply| reply.error_code).as_deref(),
            Some("VALIDATION_FAILED")
        );
        assert_eq!(process(&context, &subject, None, payload.as_bytes()).await.and_then(|reply| reply.error_code).as_deref(), Some("UNAUTHENTICATED"));
        assert!(process(&context, &format!("runtime.v1.cmd.{tenant}.{}", Uuid::now_v7()), Some(&token), payload.as_bytes()).await.is_none());
        Ok(())
    }
}
