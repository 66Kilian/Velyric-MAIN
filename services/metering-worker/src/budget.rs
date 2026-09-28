#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetState {
    pub period_budget_usd_micros: u64,
    pub unlocked_quarters: u8,
    pub consumed_usd_micros: u64,
    pub daily_cap_usd_micros: u64,
    pub monthly_cap_usd_micros: u64,
    pub soft_warning_sent: bool,
    pub hard_cap_reached: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetDecision {
    pub consumed_usd_micros: u64,
    pub unlocked_quarters: u8,
    pub set_soft_warning: bool,
    pub set_hard_cap: bool,
}

#[must_use]
pub fn apply_cost(state: &BudgetState, cost_usd_micros: u64, daily_spend_usd_micros: u64) -> BudgetDecision {
    let consumed = state.consumed_usd_micros.saturating_add(cost_usd_micros);
    let mut unlocked = state.unlocked_quarters.clamp(1, 4);
    while unlocked < 4 && u128::from(consumed) * 5 >= u128::from(state.period_budget_usd_micros) * u128::from(unlocked) {
        unlocked += 1;
    }
    let near_monthly_cap = u128::from(consumed) * 10 >= u128::from(state.monthly_cap_usd_micros) * 8;
    let budget_exhausted = consumed >= state.period_budget_usd_micros;
    BudgetDecision {
        consumed_usd_micros: consumed,
        unlocked_quarters: unlocked,
        set_soft_warning: !state.soft_warning_sent && (near_monthly_cap || budget_exhausted),
        set_hard_cap: !state.hard_cap_reached && (consumed >= state.monthly_cap_usd_micros || daily_spend_usd_micros >= state.daily_cap_usd_micros),
    }
}

#[must_use]
pub fn should_release_daily_cap(state: &BudgetState, daily_spend_today_usd_micros: u64, reached_before_today: bool) -> bool {
    state.hard_cap_reached
        && reached_before_today
        && state.consumed_usd_micros < state.monthly_cap_usd_micros
        && daily_spend_today_usd_micros < state.daily_cap_usd_micros
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn state() -> BudgetState {
        BudgetState {
            period_budget_usd_micros: 1_000_000,
            unlocked_quarters: 1,
            consumed_usd_micros: 0,
            daily_cap_usd_micros: 800_000,
            monthly_cap_usd_micros: 900_000,
            soft_warning_sent: false,
            hard_cap_reached: false,
        }
    }

    #[test]
    fn unlocks_the_next_quarter_at_eighty_percent_of_the_unlocked_budget() {
        assert_eq!(apply_cost(&state(), 199_999, 199_999).unlocked_quarters, 1);
        assert_eq!(apply_cost(&state(), 200_000, 200_000).unlocked_quarters, 2);
        assert_eq!(apply_cost(&state(), 400_000, 400_000).unlocked_quarters, 3);
        let decision = apply_cost(&state(), 250_000, 250_000);
        assert_eq!(decision, BudgetDecision { consumed_usd_micros: 250_000, unlocked_quarters: 2, set_soft_warning: false, set_hard_cap: false });
    }

    #[test]
    fn daily_and_monthly_caps_trip_the_hard_cap_once() {
        let daily = apply_cost(&BudgetState { consumed_usd_micros: 250_000, unlocked_quarters: 2, ..state() }, 600_000, 850_000);
        assert!(daily.set_hard_cap);
        assert!(daily.set_soft_warning);
        assert_eq!(daily.unlocked_quarters, 4);
        let already = apply_cost(&BudgetState { hard_cap_reached: true, soft_warning_sent: true, ..state() }, 950_000, 950_000);
        assert!(!already.set_hard_cap);
        assert!(!already.set_soft_warning);
        let monthly = apply_cost(&state(), 900_000, 100_000);
        assert!(monthly.set_hard_cap);
    }

    #[test]
    fn daily_caps_are_released_only_on_a_later_day_under_the_monthly_cap() {
        let capped = BudgetState { hard_cap_reached: true, consumed_usd_micros: 810_000, ..state() };
        assert!(should_release_daily_cap(&capped, 0, true));
        assert!(!should_release_daily_cap(&capped, 0, false));
        assert!(!should_release_daily_cap(&capped, 800_000, true));
        assert!(!should_release_daily_cap(&BudgetState { consumed_usd_micros: 900_000, ..capped.clone() }, 0, true));
        assert!(!should_release_daily_cap(&BudgetState { hard_cap_reached: false, ..capped }, 0, true));
    }

    proptest! {
        #[test]
        fn quarters_never_regress_and_hard_caps_follow_the_limits(
            budget in 1_u64..50_000_000,
            unlocked in 1_u8..=4,
            consumed in 0_u64..60_000_000,
            cost in 0_u64..10_000_000,
            daily in 0_u64..60_000_000,
            daily_cap in 1_u64..20_000_000,
            monthly_extra in 0_u64..40_000_000,
        ) {
            let current = BudgetState {
                period_budget_usd_micros: budget,
                unlocked_quarters: unlocked,
                consumed_usd_micros: consumed,
                daily_cap_usd_micros: daily_cap,
                monthly_cap_usd_micros: daily_cap + monthly_extra,
                soft_warning_sent: false,
                hard_cap_reached: false,
            };
            let decision = apply_cost(&current, cost, daily);
            prop_assert!(decision.unlocked_quarters >= unlocked);
            prop_assert!(decision.unlocked_quarters <= 4);
            prop_assert_eq!(decision.consumed_usd_micros, consumed + cost);
            let over = decision.consumed_usd_micros >= current.monthly_cap_usd_micros || daily >= daily_cap;
            prop_assert_eq!(decision.set_hard_cap, over);
        }
    }
}
