use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StopReason {
    MaxDurationReached,
    SpendCapReached,
    ToolBudgetExhausted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardVerdict {
    Continue,
    WrapUp { reason: StopReason },
    Stop { reason: StopReason },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CostLimits {
    pub max_call_duration: Duration,
    pub max_tool_executions: u32,
    pub max_spend_usd_micros_per_call: u64,
    pub remaining_daily_spend_usd_micros: Option<u64>,
    pub remaining_monthly_spend_usd_micros: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct CostGuard {
    limits: CostLimits,
    spend_usd_micros: u64,
    tool_executions: u32,
    wrap_up_window: Duration,
}

impl CostGuard {
    #[must_use]
    pub fn new(limits: CostLimits) -> Self {
        Self { limits, spend_usd_micros: 0, tool_executions: 0, wrap_up_window: Duration::from_secs(60) }
    }

    #[must_use]
    pub const fn spend_usd_micros(&self) -> u64 {
        self.spend_usd_micros
    }

    #[must_use]
    pub const fn tool_executions(&self) -> u32 {
        self.tool_executions
    }

    fn effective_spend_cap(&self) -> u64 {
        [
            Some(self.limits.max_spend_usd_micros_per_call),
            self.limits.remaining_daily_spend_usd_micros,
            self.limits.remaining_monthly_spend_usd_micros,
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(0)
    }

    pub fn record_spend(&mut self, usd_micros: u64) -> GuardVerdict {
        self.spend_usd_micros = self.spend_usd_micros.saturating_add(usd_micros);
        let cap = self.effective_spend_cap();
        if self.spend_usd_micros >= cap {
            GuardVerdict::Stop { reason: StopReason::SpendCapReached }
        } else if self.spend_usd_micros.saturating_mul(10) >= cap.saturating_mul(9) {
            GuardVerdict::WrapUp { reason: StopReason::SpendCapReached }
        } else {
            GuardVerdict::Continue
        }
    }

    pub fn try_start_tool_execution(&mut self) -> GuardVerdict {
        if self.tool_executions >= self.limits.max_tool_executions {
            return GuardVerdict::Stop { reason: StopReason::ToolBudgetExhausted };
        }
        self.tool_executions += 1;
        GuardVerdict::Continue
    }

    #[must_use]
    pub fn check_elapsed(&self, elapsed: Duration) -> GuardVerdict {
        if elapsed >= self.limits.max_call_duration {
            GuardVerdict::Stop { reason: StopReason::MaxDurationReached }
        } else if elapsed.saturating_add(self.wrap_up_window) >= self.limits.max_call_duration {
            GuardVerdict::WrapUp { reason: StopReason::MaxDurationReached }
        } else {
            GuardVerdict::Continue
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn limits() -> CostLimits {
        CostLimits {
            max_call_duration: Duration::from_secs(1_800),
            max_tool_executions: 3,
            max_spend_usd_micros_per_call: 2_000_000,
            remaining_daily_spend_usd_micros: Some(5_000_000),
            remaining_monthly_spend_usd_micros: None,
        }
    }

    #[test]
    fn wraps_up_before_and_stops_at_the_duration_limit() {
        let guard = CostGuard::new(limits());
        assert_eq!(guard.check_elapsed(Duration::from_secs(600)), GuardVerdict::Continue);
        assert_eq!(guard.check_elapsed(Duration::from_secs(1_750)), GuardVerdict::WrapUp { reason: StopReason::MaxDurationReached });
        assert_eq!(guard.check_elapsed(Duration::from_secs(1_800)), GuardVerdict::Stop { reason: StopReason::MaxDurationReached });
    }

    #[test]
    fn uses_the_tightest_of_call_daily_and_monthly_caps() {
        let mut guard = CostGuard::new(CostLimits { remaining_daily_spend_usd_micros: Some(500_000), ..limits() });
        assert_eq!(guard.record_spend(400_000), GuardVerdict::Continue);
        assert_eq!(guard.record_spend(60_000), GuardVerdict::WrapUp { reason: StopReason::SpendCapReached });
        assert_eq!(guard.record_spend(40_000), GuardVerdict::Stop { reason: StopReason::SpendCapReached });
        assert_eq!(guard.spend_usd_micros(), 500_000);
    }

    #[test]
    fn stops_agent_loops_at_the_tool_budget() {
        let mut guard = CostGuard::new(limits());
        for _ in 0..3 {
            assert_eq!(guard.try_start_tool_execution(), GuardVerdict::Continue);
        }
        assert_eq!(guard.try_start_tool_execution(), GuardVerdict::Stop { reason: StopReason::ToolBudgetExhausted });
        assert_eq!(guard.tool_executions(), 3);
    }

    proptest! {
        #[test]
        fn spend_never_silently_exceeds_the_cap(increments in proptest::collection::vec(0u64..300_000, 1..40)) {
            let stop = GuardVerdict::Stop { reason: StopReason::SpendCapReached };
            let mut guard = CostGuard::new(limits());
            for increment in increments {
                let verdict = guard.record_spend(increment);
                if guard.spend_usd_micros() >= 2_000_000 {
                    prop_assert_eq!(verdict, stop);
                } else {
                    prop_assert_ne!(verdict, stop);
                }
            }
        }
    }
}
