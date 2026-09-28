use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing::warn;
use uuid::Uuid;
use velyric_call_protocol::RoutingSnapshot;
use velyric_runtime_policy::admission::{
    AdmissionError, AdmissionOutcome, AdmissionRequest, AdmissionScope, AdmissionSlot, AdmissionStore, LocalAdmissionStore, RedisAdmissionStore,
};

use crate::config::Environment;
use crate::metrics::Metrics;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionLimits {
    pub global_max_calls: u32,
    pub provider_max_calls: u32,
    pub fallback_max_calls_per_tenant: u32,
    pub lease: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionVerdict {
    Admitted { degraded: bool },
    Rejected { reason: &'static str },
}

#[must_use]
pub const fn reject_reason(scope: AdmissionScope) -> &'static str {
    match scope {
        AdmissionScope::Global => "GLOBAL_CAPACITY",
        AdmissionScope::Provider => "PROVIDER_CAPACITY",
        AdmissionScope::Tenant => "TENANT_CONCURRENCY_LIMIT",
        AdmissionScope::Location => "LOCATION_CONCURRENCY_LIMIT",
        AdmissionScope::Number => "NUMBER_CONCURRENCY_LIMIT",
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

const fn verdict(outcome: AdmissionOutcome, degraded: bool) -> AdmissionVerdict {
    match outcome {
        AdmissionOutcome::Admitted => AdmissionVerdict::Admitted { degraded },
        AdmissionOutcome::Rejected { scope } => AdmissionVerdict::Rejected { reason: reject_reason(scope) },
    }
}

pub struct AdmissionGate {
    redis: Option<RedisAdmissionStore>,
    fallback: LocalAdmissionStore,
    prefix: String,
    region: String,
    limits: AdmissionLimits,
}

impl AdmissionGate {
    #[must_use]
    pub fn new(redis: Option<RedisAdmissionStore>, environment: Environment, region: &str, limits: AdmissionLimits) -> Self {
        Self {
            redis,
            fallback: LocalAdmissionStore::conservative(limits.fallback_max_calls_per_tenant),
            prefix: format!("vly:{}", environment.as_str()),
            region: region.to_owned(),
            limits,
        }
    }

    pub fn request(&self, call_id: Uuid, routing: &RoutingSnapshot, provider: &str) -> Result<AdmissionRequest, &'static str> {
        let entitlement = routing.entitlement.as_ref().ok_or("ENTITLEMENT_INACTIVE")?;
        if entitlement.max_concurrent_calls == 0 {
            return Err("ENTITLEMENT_INACTIVE");
        }
        let tenant_limit = entitlement.max_concurrent_calls;
        let number_limit = entitlement.number_concurrency.map_or(tenant_limit, |limit| limit.clamp(1, tenant_limit));
        let prefix = &self.prefix;
        let region = &self.region;
        Ok(AdmissionRequest {
            call_id,
            slots: vec![
                AdmissionSlot { scope: AdmissionScope::Global, key: format!("{prefix}:adm:global:{region}"), limit: self.limits.global_max_calls },
                AdmissionSlot {
                    scope: AdmissionScope::Provider,
                    key: format!("{prefix}:adm:provider:{provider}:{region}"),
                    limit: self.limits.provider_max_calls,
                },
                AdmissionSlot { scope: AdmissionScope::Tenant, key: format!("{prefix}:adm:tenant:{}", routing.tenant_id), limit: tenant_limit },
                AdmissionSlot {
                    scope: AdmissionScope::Number,
                    key: format!("{prefix}:adm:number:{}:{}", routing.tenant_id, routing.phone_number_id),
                    limit: number_limit,
                },
            ],
            lease: self.limits.lease,
        })
    }

    pub async fn acquire(&self, request: &AdmissionRequest, metrics: &Metrics) -> Result<AdmissionVerdict, AdmissionError> {
        let now = now_ms();
        if let Some(redis) = &self.redis {
            match redis.acquire(request, now).await {
                Ok(outcome) => return Ok(verdict(outcome, false)),
                Err(AdmissionError::Unavailable(detail)) => {
                    warn!(%detail, "distributed admission unavailable; applying the conservative per-instance limit");
                    metrics.increment("admission_fallback", "store", "local");
                }
                Err(error) => return Err(error),
            }
        }
        let outcome = self.fallback.acquire(request, now).await?;
        Ok(verdict(outcome, self.redis.is_some()))
    }

    pub async fn heartbeat(&self, request: &AdmissionRequest) {
        let now = now_ms();
        if let Some(redis) = &self.redis
            && let Err(error) = redis.heartbeat(request, now).await
        {
            warn!(error = %error, call_id = %request.call_id, "admission lease heartbeat failed");
        }
        if let Err(error) = self.fallback.heartbeat(request, now).await {
            warn!(error = %error, call_id = %request.call_id, "local admission lease heartbeat failed");
        }
    }

    pub async fn release(&self, request: &AdmissionRequest) {
        if let Some(redis) = &self.redis
            && let Err(error) = redis.release(request).await
        {
            warn!(error = %error, call_id = %request.call_id, "admission lease release failed; the lease will expire");
        }
        if let Err(error) = self.fallback.release(request).await {
            warn!(error = %error, call_id = %request.call_id, "local admission lease release failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::routing_snapshot;

    fn gate(fallback: u32) -> AdmissionGate {
        AdmissionGate::new(
            None,
            Environment::Ci,
            "eu-central-1",
            AdmissionLimits { global_max_calls: 100, provider_max_calls: 100, fallback_max_calls_per_tenant: fallback, lease: Duration::from_secs(30) },
        )
    }

    #[test]
    fn builds_slots_in_topology_order_with_redis_key_contract() -> Result<(), &'static str> {
        let tenant = Uuid::from_u128(0x0192_f5e4_7a1b_7c3d_8e9f_0a1b_2c3d_4e5f);
        let mut routing = routing_snapshot(tenant, Uuid::from_u128(9));
        if let Some(entitlement) = routing.entitlement.as_mut() {
            entitlement.number_concurrency = Some(50);
        }
        let request = gate(1).request(Uuid::from_u128(1), &routing, "openai")?;
        let keys: Vec<(&str, u32)> = request.slots.iter().map(|slot| (slot.key.as_str(), slot.limit)).collect();
        assert_eq!(
            keys,
            vec![
                ("vly:ci:adm:global:eu-central-1", 100),
                ("vly:ci:adm:provider:openai:eu-central-1", 100),
                ("vly:ci:adm:tenant:0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e5f", 2),
                (&*format!("vly:ci:adm:number:0192f5e4-7a1b-7c3d-8e9f-0a1b2c3d4e5f:{}", routing.phone_number_id), 2),
            ]
        );
        routing.entitlement = None;
        assert_eq!(gate(1).request(Uuid::from_u128(1), &routing, "openai").err(), Some("ENTITLEMENT_INACTIVE"));
        Ok(())
    }

    #[tokio::test]
    async fn local_admission_enforces_the_tenant_limit_and_frees_released_slots() -> Result<(), Box<dyn std::error::Error>> {
        let metrics = Metrics::new(crate::METRICS_PREFIX);
        let gate = gate(32);
        let routing = routing_snapshot(Uuid::now_v7(), Uuid::now_v7());
        let first = gate.request(Uuid::now_v7(), &routing, "openai")?;
        let second = gate.request(Uuid::now_v7(), &routing, "openai")?;
        let third = gate.request(Uuid::now_v7(), &routing, "openai")?;
        assert_eq!(gate.acquire(&first, &metrics).await?, AdmissionVerdict::Admitted { degraded: false });
        assert_eq!(gate.acquire(&second, &metrics).await?, AdmissionVerdict::Admitted { degraded: false });
        assert_eq!(gate.acquire(&third, &metrics).await?, AdmissionVerdict::Rejected { reason: "TENANT_CONCURRENCY_LIMIT" });
        gate.release(&first).await;
        assert_eq!(gate.acquire(&third, &metrics).await?, AdmissionVerdict::Admitted { degraded: false });
        Ok(())
    }
}
