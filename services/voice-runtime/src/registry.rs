use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use tokio::sync::{Notify, mpsc, oneshot};
use uuid::Uuid;
use velyric_call_protocol::{RuntimeCommand, RuntimeCommandReply};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownReason {
    DrainTimeout,
    KillSwitch,
}

#[derive(Debug)]
pub enum SessionCommand {
    Runtime { command: RuntimeCommand, reply: oneshot::Sender<RuntimeCommandReply> },
    Shutdown { reason: ShutdownReason },
}

#[derive(Debug, Clone)]
pub struct SessionHandle {
    pub tenant_id: Uuid,
    pub commands: mpsc::Sender<SessionCommand>,
}

#[derive(Debug, Default)]
pub struct Registry {
    sessions: DashMap<Uuid, SessionHandle>,
    draining: AtomicBool,
    idle: Notify,
}

impl Registry {
    #[must_use]
    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    pub fn start_drain(&self) -> bool {
        !self.draining.swap(true, Ordering::SeqCst)
    }

    pub fn insert(&self, call_id: Uuid, handle: SessionHandle) {
        self.sessions.insert(call_id, handle);
    }

    pub fn remove(&self, call_id: Uuid) {
        self.sessions.remove(&call_id);
        if self.sessions.is_empty() {
            self.idle.notify_waiters();
        }
    }

    #[must_use]
    pub fn lookup(&self, tenant_id: Uuid, call_id: Uuid) -> Option<mpsc::Sender<SessionCommand>> {
        self.sessions
            .get(&call_id)
            .and_then(|handle| (handle.tenant_id == tenant_id).then(|| handle.commands.clone()))
    }

    #[must_use]
    pub fn contains(&self, call_id: Uuid) -> bool {
        self.sessions.contains_key(&call_id)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    #[must_use]
    pub fn senders(&self) -> Vec<mpsc::Sender<SessionCommand>> {
        self.sessions.iter().map(|entry| entry.value().commands.clone()).collect()
    }

    pub async fn wait_until_idle(&self, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, async {
            loop {
                let notified = self.idle.notified();
                if self.sessions.is_empty() {
                    return;
                }
                notified.await;
            }
        })
        .await
        .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn lookups_are_tenant_bound_and_idle_waiters_wake_when_the_last_call_ends() {
        let registry = Arc::new(Registry::default());
        let (sender, _receiver) = mpsc::channel(1);
        let tenant = Uuid::from_u128(1);
        let call = Uuid::from_u128(2);
        registry.insert(call, SessionHandle { tenant_id: tenant, commands: sender });
        assert!(registry.lookup(tenant, call).is_some());
        assert!(registry.lookup(Uuid::from_u128(3), call).is_none());
        assert!(!registry.wait_until_idle(Duration::from_millis(20)).await);
        let waiter = tokio::spawn({
            let registry = Arc::clone(&registry);
            async move { registry.wait_until_idle(Duration::from_secs(2)).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        registry.remove(call);
        assert!(matches!(waiter.await, Ok(true)));
        assert!(registry.start_drain());
        assert!(!registry.start_drain());
        assert!(registry.is_draining());
    }
}
