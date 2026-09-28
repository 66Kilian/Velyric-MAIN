use std::collections::HashMap;
use std::time::Duration;

use redis::Script;
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AdmissionScope {
    Global,
    Provider,
    Tenant,
    Location,
    Number,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionSlot {
    pub scope: AdmissionScope,
    pub key: String,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionRequest {
    pub call_id: Uuid,
    pub slots: Vec<AdmissionSlot>,
    pub lease: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionOutcome {
    Admitted,
    Rejected { scope: AdmissionScope },
}

#[derive(Debug, Error)]
pub enum AdmissionError {
    #[error("admission store unavailable: {0}")]
    Unavailable(String),
    #[error("invalid admission request: {0}")]
    Invalid(&'static str),
}

pub trait AdmissionStore: Send + Sync {
    fn acquire(
        &self,
        request: &AdmissionRequest,
        now_ms: u64,
    ) -> impl Future<Output = Result<AdmissionOutcome, AdmissionError>> + Send;

    fn heartbeat(
        &self,
        request: &AdmissionRequest,
        now_ms: u64,
    ) -> impl Future<Output = Result<(), AdmissionError>> + Send;

    fn release(
        &self,
        request: &AdmissionRequest,
    ) -> impl Future<Output = Result<(), AdmissionError>> + Send;
}

fn validate(request: &AdmissionRequest) -> Result<u64, AdmissionError> {
    if request.slots.is_empty() {
        return Err(AdmissionError::Invalid("at least one admission slot is required"));
    }
    if request.slots.len() > 8 {
        return Err(AdmissionError::Invalid("too many admission slots"));
    }
    if request.slots.iter().any(|slot| slot.key.is_empty()) {
        return Err(AdmissionError::Invalid("admission keys must not be empty"));
    }
    let lease_ms = u64::try_from(request.lease.as_millis())
        .map_err(|_| AdmissionError::Invalid("lease is too long"))?;
    if !(1_000..=300_000).contains(&lease_ms) {
        return Err(AdmissionError::Invalid("lease must be between 1 and 300 seconds"));
    }
    Ok(lease_ms)
}

const ACQUIRE_SCRIPT: &str = r"
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
local member = ARGV[3]
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  if redis.call('ZSCORE', KEYS[i], member) == false then
    if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[3 + i]) then
      return i
    end
  end
end
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], now + lease, member)
  redis.call('PEXPIRE', KEYS[i], lease * 2)
end
return 0
";

const HEARTBEAT_SCRIPT: &str = r"
local expires = tonumber(ARGV[1]) + tonumber(ARGV[2])
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], 'XX', expires, ARGV[3])
  redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[2]) * 2)
end
return 0
";

const RELEASE_SCRIPT: &str = r"
for i = 1, #KEYS do
  redis.call('ZREM', KEYS[i], ARGV[1])
end
return 0
";

pub struct RedisAdmissionStore {
    connection: ConnectionManager,
    acquire: Script,
    heartbeat: Script,
    release: Script,
}

impl RedisAdmissionStore {
    pub async fn connect(url: &str) -> Result<Self, AdmissionError> {
        let client = redis::Client::open(url).map_err(|error| AdmissionError::Unavailable(error.to_string()))?;
        let connection = ConnectionManager::new(client)
            .await
            .map_err(|error| AdmissionError::Unavailable(error.to_string()))?;
        Ok(Self {
            connection,
            acquire: Script::new(ACQUIRE_SCRIPT),
            heartbeat: Script::new(HEARTBEAT_SCRIPT),
            release: Script::new(RELEASE_SCRIPT),
        })
    }
}

impl AdmissionStore for RedisAdmissionStore {
    async fn acquire(&self, request: &AdmissionRequest, now_ms: u64) -> Result<AdmissionOutcome, AdmissionError> {
        let lease_ms = validate(request)?;
        let mut invocation = self.acquire.prepare_invoke();
        for slot in &request.slots {
            invocation.key(&slot.key);
        }
        invocation.arg(now_ms).arg(lease_ms).arg(request.call_id.to_string());
        for slot in &request.slots {
            invocation.arg(slot.limit);
        }
        let mut connection = self.connection.clone();
        let failed: i64 = invocation
            .invoke_async(&mut connection)
            .await
            .map_err(|error| AdmissionError::Unavailable(error.to_string()))?;
        if failed == 0 {
            return Ok(AdmissionOutcome::Admitted);
        }
        let index = usize::try_from(failed - 1).map_err(|_| AdmissionError::Unavailable("unexpected script result".into()))?;
        request
            .slots
            .get(index)
            .map(|slot| AdmissionOutcome::Rejected { scope: slot.scope })
            .ok_or_else(|| AdmissionError::Unavailable("unexpected script result".into()))
    }

    async fn heartbeat(&self, request: &AdmissionRequest, now_ms: u64) -> Result<(), AdmissionError> {
        let lease_ms = validate(request)?;
        let mut invocation = self.heartbeat.prepare_invoke();
        for slot in &request.slots {
            invocation.key(&slot.key);
        }
        invocation.arg(now_ms).arg(lease_ms).arg(request.call_id.to_string());
        let mut connection = self.connection.clone();
        let _: i64 = invocation
            .invoke_async(&mut connection)
            .await
            .map_err(|error| AdmissionError::Unavailable(error.to_string()))?;
        Ok(())
    }

    async fn release(&self, request: &AdmissionRequest) -> Result<(), AdmissionError> {
        validate(request)?;
        let mut invocation = self.release.prepare_invoke();
        for slot in &request.slots {
            invocation.key(&slot.key);
        }
        invocation.arg(request.call_id.to_string());
        let mut connection = self.connection.clone();
        let _: i64 = invocation
            .invoke_async(&mut connection)
            .await
            .map_err(|error| AdmissionError::Unavailable(error.to_string()))?;
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct LocalAdmissionStore {
    leases: Mutex<HashMap<String, HashMap<Uuid, u64>>>,
    conservative_tenant_limit: Option<u32>,
}

impl LocalAdmissionStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn conservative(max_calls_per_tenant: u32) -> Self {
        Self {
            leases: Mutex::default(),
            conservative_tenant_limit: Some(max_calls_per_tenant.max(1)),
        }
    }

    fn effective_limit(&self, slot: &AdmissionSlot) -> u32 {
        match (slot.scope, self.conservative_tenant_limit) {
            (AdmissionScope::Tenant, Some(fallback)) => slot.limit.min(fallback),
            _ => slot.limit,
        }
    }
}

impl AdmissionStore for LocalAdmissionStore {
    async fn acquire(&self, request: &AdmissionRequest, now_ms: u64) -> Result<AdmissionOutcome, AdmissionError> {
        let lease_ms = validate(request)?;
        let mut leases = self.leases.lock().await;
        for slot in &request.slots {
            let members = leases.entry(slot.key.clone()).or_default();
            members.retain(|_, expires| *expires > now_ms);
            let occupied = u32::try_from(members.len()).unwrap_or(u32::MAX);
            if !members.contains_key(&request.call_id) && occupied >= self.effective_limit(slot) {
                return Ok(AdmissionOutcome::Rejected { scope: slot.scope });
            }
        }
        for slot in &request.slots {
            leases
                .entry(slot.key.clone())
                .or_default()
                .insert(request.call_id, now_ms.saturating_add(lease_ms));
        }
        Ok(AdmissionOutcome::Admitted)
    }

    async fn heartbeat(&self, request: &AdmissionRequest, now_ms: u64) -> Result<(), AdmissionError> {
        let lease_ms = validate(request)?;
        let mut leases = self.leases.lock().await;
        for slot in &request.slots {
            if let Some(expires) = leases.get_mut(&slot.key).and_then(|members| members.get_mut(&request.call_id)) {
                *expires = now_ms.saturating_add(lease_ms);
            }
        }
        Ok(())
    }

    async fn release(&self, request: &AdmissionRequest) -> Result<(), AdmissionError> {
        validate(request)?;
        let mut leases = self.leases.lock().await;
        for slot in &request.slots {
            if let Some(members) = leases.get_mut(&slot.key) {
                members.remove(&request.call_id);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(call: u128, tenant_limit: u32) -> AdmissionRequest {
        AdmissionRequest {
            call_id: Uuid::from_u128(call),
            slots: vec![
                AdmissionSlot { scope: AdmissionScope::Global, key: "vly:ci:adm:global:eu-central-1".into(), limit: 1_000 },
                AdmissionSlot { scope: AdmissionScope::Tenant, key: "vly:ci:adm:tenant:t1".into(), limit: tenant_limit },
                AdmissionSlot { scope: AdmissionScope::Number, key: "vly:ci:adm:number:t1:n1".into(), limit: 10 },
            ],
            lease: Duration::from_secs(30),
        }
    }

    #[tokio::test]
    async fn enforces_the_tenant_plan_limit_without_partial_reservations() -> Result<(), AdmissionError> {
        let store = LocalAdmissionStore::new();
        assert_eq!(store.acquire(&request(1, 2), 1_000).await?, AdmissionOutcome::Admitted);
        assert_eq!(store.acquire(&request(2, 2), 1_000).await?, AdmissionOutcome::Admitted);
        assert_eq!(store.acquire(&request(3, 2), 1_000).await?, AdmissionOutcome::Rejected { scope: AdmissionScope::Tenant });
        let leases = store.leases.lock().await;
        let global = leases.get("vly:ci:adm:global:eu-central-1").map_or(0, HashMap::len);
        assert_eq!(global, 2);
        Ok(())
    }

    #[tokio::test]
    async fn re_acquiring_the_same_call_is_idempotent_and_release_frees_capacity() -> Result<(), AdmissionError> {
        let store = LocalAdmissionStore::new();
        assert_eq!(store.acquire(&request(1, 1), 0).await?, AdmissionOutcome::Admitted);
        assert_eq!(store.acquire(&request(1, 1), 10).await?, AdmissionOutcome::Admitted);
        assert_eq!(store.acquire(&request(2, 1), 10).await?, AdmissionOutcome::Rejected { scope: AdmissionScope::Tenant });
        store.release(&request(1, 1)).await?;
        assert_eq!(store.acquire(&request(2, 1), 20).await?, AdmissionOutcome::Admitted);
        Ok(())
    }

    #[tokio::test]
    async fn expired_leases_from_crashed_instances_are_reclaimed_and_heartbeats_extend_leases() -> Result<(), AdmissionError> {
        let store = LocalAdmissionStore::new();
        assert_eq!(store.acquire(&request(1, 1), 0).await?, AdmissionOutcome::Admitted);
        store.heartbeat(&request(1, 1), 25_000).await?;
        assert_eq!(store.acquire(&request(2, 1), 40_000).await?, AdmissionOutcome::Rejected { scope: AdmissionScope::Tenant });
        assert_eq!(store.acquire(&request(2, 1), 55_001).await?, AdmissionOutcome::Admitted);
        Ok(())
    }

    #[tokio::test]
    async fn conservative_fallback_never_exceeds_the_plan_limit() -> Result<(), AdmissionError> {
        let store = LocalAdmissionStore::conservative(1);
        assert_eq!(store.acquire(&request(1, 50), 0).await?, AdmissionOutcome::Admitted);
        assert_eq!(store.acquire(&request(2, 50), 0).await?, AdmissionOutcome::Rejected { scope: AdmissionScope::Tenant });
        Ok(())
    }

    #[tokio::test]
    async fn rejects_invalid_requests() {
        let store = LocalAdmissionStore::new();
        let mut empty = request(1, 1);
        empty.slots.clear();
        assert!(matches!(store.acquire(&empty, 0).await, Err(AdmissionError::Invalid(_))));
        let mut short = request(1, 1);
        short.lease = Duration::from_millis(10);
        assert!(matches!(store.acquire(&short, 0).await, Err(AdmissionError::Invalid(_))));
    }

    #[tokio::test]
    #[ignore = "requires VELYRIC_TEST_REDIS_URL; runs in CI with the redis service container"]
    async fn redis_store_matches_local_semantics() -> Result<(), AdmissionError> {
        let url = std::env::var("VELYRIC_TEST_REDIS_URL").map_err(|_| AdmissionError::Invalid("VELYRIC_TEST_REDIS_URL is not set"))?;
        let store = RedisAdmissionStore::connect(&url).await?;
        let base = u128::from(std::process::id()) << 64;
        let mut first = request(base + 1, 1);
        let mut second = request(base + 2, 1);
        for slot in first.slots.iter_mut().chain(second.slots.iter_mut()) {
            slot.key = format!("{}:{base}", slot.key);
        }
        assert_eq!(store.acquire(&first, 1_000).await?, AdmissionOutcome::Admitted);
        assert_eq!(store.acquire(&second, 1_000).await?, AdmissionOutcome::Rejected { scope: AdmissionScope::Tenant });
        store.release(&first).await?;
        assert_eq!(store.acquire(&second, 1_000).await?, AdmissionOutcome::Admitted);
        store.release(&second).await?;
        Ok(())
    }
}
