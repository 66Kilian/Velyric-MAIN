use std::collections::HashMap;

use serde::Deserialize;
use velyric_service_kit::env::valid_token;

pub const COST_METRICS: [&str; 2] = ["live_voice_cost", "tool_external_cost"];
pub const TOKEN_METRICS: [&str; 2] = ["backend_input_tokens", "backend_output_tokens"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenPrice {
    pub input_usd_micros_per_million: u64,
    pub output_usd_micros_per_million: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PriceTable {
    models: HashMap<String, TokenPrice>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pricing {
    Cost(u64),
    Unpriced,
    NotCost,
}

#[must_use]
pub fn expected_unit(metric: &str) -> Option<&'static str> {
    match metric {
        "connected_voice_seconds" | "billable_voice_seconds" | "carrier_seconds" | "recording_seconds" | "simulation_seconds" => Some("SECONDS"),
        "live_voice_cost" | "tool_external_cost" => Some("USD_MICROS"),
        "backend_input_tokens" | "backend_output_tokens" => Some("TOKENS"),
        "email_count" => Some("COUNT"),
        _ => None,
    }
}

impl PriceTable {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let models: HashMap<String, TokenPrice> = serde_json::from_str(raw).map_err(|error| format!("token price table is not valid JSON: {error}"))?;
        if models.is_empty() {
            return Err("token price table must contain at least one model".to_owned());
        }
        if let Some(invalid) = models.keys().find(|model| !valid_token(model, 100)) {
            return Err(format!("token price table contains an invalid model identifier: {invalid}"));
        }
        Ok(Self { models })
    }

    #[must_use]
    pub fn price(&self, model: &str) -> Option<TokenPrice> {
        self.models.get(model).copied()
    }

    #[must_use]
    pub fn cost(&self, metric: &str, model: Option<&str>, quantity: u64) -> Pricing {
        if COST_METRICS.contains(&metric) {
            return Pricing::Cost(quantity);
        }
        if !TOKEN_METRICS.contains(&metric) {
            return Pricing::NotCost;
        }
        let Some(price) = model.and_then(|model| self.price(model)) else {
            return Pricing::Unpriced;
        };
        let per_million = if metric == "backend_input_tokens" { price.input_usd_micros_per_million } else { price.output_usd_micros_per_million };
        let micros = (u128::from(quantity) * u128::from(per_million)).div_ceil(1_000_000);
        Pricing::Cost(u64::try_from(micros).unwrap_or(u64::MAX))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const TABLE: &str = r#"{
        "gpt-5.6-luna": { "input_usd_micros_per_million": 200000, "output_usd_micros_per_million": 1200000 },
        "gpt-5.6-terra": { "input_usd_micros_per_million": 2000000, "output_usd_micros_per_million": 12000000 }
    }"#;

    #[test]
    fn prices_tokens_per_model_and_passes_through_cost_metrics() -> Result<(), String> {
        let table = PriceTable::parse(TABLE)?;
        assert_eq!(table.cost("backend_input_tokens", Some("gpt-5.6-luna"), 1_200_000), Pricing::Cost(240_000));
        assert_eq!(table.cost("backend_output_tokens", Some("gpt-5.6-terra"), 80), Pricing::Cost(960));
        assert_eq!(table.cost("backend_output_tokens", Some("gpt-5.6-luna"), 1), Pricing::Cost(2));
        assert_eq!(table.cost("backend_input_tokens", Some("unknown-model"), 10), Pricing::Unpriced);
        assert_eq!(table.cost("backend_input_tokens", None, 10), Pricing::Unpriced);
        assert_eq!(table.cost("live_voice_cost", None, 35_000), Pricing::Cost(35_000));
        assert_eq!(table.cost("connected_voice_seconds", None, 42), Pricing::NotCost);
        assert_eq!(expected_unit("backend_input_tokens"), Some("TOKENS"));
        assert_eq!(expected_unit("made_up"), None);
        Ok(())
    }

    #[test]
    fn rejects_empty_malformed_or_extended_price_tables() {
        assert!(PriceTable::parse("{}").is_err());
        assert!(PriceTable::parse("[]").is_err());
        assert!(PriceTable::parse(r#"{"bad model": {"input_usd_micros_per_million": 1, "output_usd_micros_per_million": 1}}"#).is_err());
        assert!(PriceTable::parse(r#"{"m": {"input_usd_micros_per_million": 1, "output_usd_micros_per_million": 1, "cached": 1}}"#).is_err());
    }

    proptest! {
        #[test]
        fn token_costs_never_round_down_to_free(quantity in 1_u64..10_000_000_000, price in 1_u64..100_000_000) {
            let table = PriceTable { models: HashMap::from([("m".to_owned(), TokenPrice { input_usd_micros_per_million: price, output_usd_micros_per_million: price })]) };
            let Pricing::Cost(cost) = table.cost("backend_input_tokens", Some("m"), quantity) else {
                return Err(TestCaseError::fail("priced model must yield a cost"));
            };
            prop_assert!(cost >= 1);
            prop_assert!(u128::from(cost) * 1_000_000 >= u128::from(quantity) * u128::from(price));
            prop_assert!(u128::from(cost - 1) * 1_000_000 < u128::from(quantity) * u128::from(price));
        }
    }
}
