use std::str::FromStr;
use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgPool, Postgres, Row, Transaction};
use thiserror::Error;
use time::{OffsetDateTime, Time, UtcOffset};
use uuid::Uuid;
use velyric_call_protocol::UsageRecord;

use crate::budget::{BudgetState, apply_cost, should_release_daily_cap};
use crate::pricing::{COST_METRICS, PriceTable, Pricing, TOKEN_METRICS};

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("referenced row does not exist yet: {0}")]
    MissingReference(String),
    #[error("usage record violates a database constraint: {0}")]
    Invalid(String),
    #[error("database unavailable: {0}")]
    Unavailable(String),
}

impl From<sqlx::Error> for StoreError {
    fn from(error: sqlx::Error) -> Self {
        let code = error.as_database_error().and_then(|database| database.code().map(|code| code.into_owned()));
        match code.as_deref() {
            Some("23503") => Self::MissingReference(error.to_string()),
            Some(code) if code.starts_with("22") || code.starts_with("23") => Self::Invalid(error.to_string()),
            _ => Self::Unavailable(error.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordOutcome {
    Recorded { cost_usd_micros: u64, unpriced: bool, hard_cap_reached: bool },
    Duplicate,
}

#[must_use]
pub fn day_start(value: OffsetDateTime) -> OffsetDateTime {
    value.to_offset(UtcOffset::UTC).replace_time(Time::MIDNIGHT)
}

#[must_use]
pub fn month_start(value: OffsetDateTime) -> OffsetDateTime {
    let day = day_start(value);
    day.replace_day(1).unwrap_or(day)
}

fn to_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

pub struct Store {
    pool: PgPool,
}

const BUDGET_FOR_PERIOD: &str = "SELECT id, billing_period_start, period_budget_usd_micros, unlocked_quarters, consumed_usd_micros, daily_cap_usd_micros, monthly_cap_usd_micros, soft_warning_sent_at IS NOT NULL AS soft_warning_sent, hard_cap_reached_at IS NOT NULL AS hard_cap_reached, hard_cap_reached_at FROM cost_budgets WHERE billing_period_start <= $1 AND billing_period_end > $1 FOR UPDATE";

const CAPPED_BUDGET_FOR_PERIOD: &str = "SELECT id, billing_period_start, period_budget_usd_micros, unlocked_quarters, consumed_usd_micros, daily_cap_usd_micros, monthly_cap_usd_micros, soft_warning_sent_at IS NOT NULL AS soft_warning_sent, hard_cap_reached_at IS NOT NULL AS hard_cap_reached, hard_cap_reached_at FROM cost_budgets WHERE billing_period_start <= $1 AND billing_period_end > $1 AND hard_cap_reached_at IS NOT NULL FOR UPDATE";

fn budget_state(row: &sqlx::postgres::PgRow) -> Result<BudgetState, StoreError> {
    Ok(BudgetState {
        period_budget_usd_micros: to_u64(row.try_get("period_budget_usd_micros")?),
        unlocked_quarters: u8::try_from(row.try_get::<i16, _>("unlocked_quarters")?).unwrap_or(1),
        consumed_usd_micros: to_u64(row.try_get("consumed_usd_micros")?),
        daily_cap_usd_micros: to_u64(row.try_get("daily_cap_usd_micros")?),
        monthly_cap_usd_micros: to_u64(row.try_get("monthly_cap_usd_micros")?),
        soft_warning_sent: row.try_get("soft_warning_sent")?,
        hard_cap_reached: row.try_get("hard_cap_reached")?,
    })
}

impl Store {
    pub async fn connect(url: &str, role: Option<&str>, max_connections: u32) -> Result<Self, StoreError> {
        let mut parameters = vec![("search_path", "app,public".to_owned()), ("statement_timeout", "5000".to_owned())];
        if let Some(role) = role {
            parameters.push(("role", role.to_owned()));
        }
        let options = PgConnectOptions::from_str(url)
            .map_err(|error| StoreError::Unavailable(error.to_string()))?
            .application_name("metering-worker")
            .options(parameters);
        let pool = PgPoolOptions::new().max_connections(max_connections).acquire_timeout(Duration::from_secs(5)).connect_with(options).await?;
        Ok(Self { pool })
    }

    pub async fn ping(&self) -> bool {
        sqlx::query("SELECT 1").execute(&self.pool).await.is_ok()
    }

    async fn begin_tenant(&self, tenant_id: Uuid) -> Result<Transaction<'static, Postgres>, StoreError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_type', 'SERVICE', true), set_config('app.actor_id', 'metering-worker', true)",
        )
        .bind(tenant_id.to_string())
        .execute(&mut *transaction)
        .await?;
        Ok(transaction)
    }

    async fn daily_spend(transaction: &mut Transaction<'static, Postgres>, prices: &PriceTable, since: OffsetDateTime) -> Result<u64, StoreError> {
        let metrics: Vec<String> = COST_METRICS.iter().chain(TOKEN_METRICS.iter()).map(|metric| (*metric).to_owned()).collect();
        let rows = sqlx::query(
            "SELECT metric, model, sum(quantity)::bigint AS quantity FROM usage_events WHERE occurred_at >= $1 AND metric = ANY($2) GROUP BY metric, model",
        )
        .bind(since)
        .bind(metrics)
        .fetch_all(&mut **transaction)
        .await?;
        let mut total = 0_u64;
        for row in rows {
            let metric: String = row.try_get("metric")?;
            let model: Option<String> = row.try_get("model")?;
            if let Pricing::Cost(cost) = prices.cost(&metric, model.as_deref(), to_u64(row.try_get("quantity")?)) {
                total = total.saturating_add(cost);
            }
        }
        Ok(total)
    }

    pub async fn record_usage(&self, record: &UsageRecord, occurred_at: OffsetDateTime, prices: &PriceTable) -> Result<RecordOutcome, StoreError> {
        let quantity = u64::try_from(record.quantity).map_err(|_| StoreError::Invalid("usage quantity must not be negative".to_owned()))?;
        let pricing = prices.cost(&record.metric, record.model.as_deref(), quantity);
        let cost = if let Pricing::Cost(cost) = pricing { cost } else { 0 };
        let mut transaction = self.begin_tenant(record.tenant_id).await?;
        let inserted = sqlx::query(
            "INSERT INTO usage_events (tenant_id, call_id, metric, quantity, unit, provider, model, source_event_id, occurred_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_id, source_event_id, metric) DO NOTHING RETURNING id",
        )
        .bind(record.tenant_id)
        .bind(record.call_id)
        .bind(&record.metric)
        .bind(record.quantity)
        .bind(&record.unit)
        .bind(record.provider.as_deref())
        .bind(record.model.as_deref())
        .bind(record.source_event_id)
        .bind(occurred_at)
        .fetch_optional(&mut *transaction)
        .await?;
        if inserted.is_none() {
            transaction.rollback().await?;
            return Ok(RecordOutcome::Duplicate);
        }
        let budget = sqlx::query(BUDGET_FOR_PERIOD)
            .bind(occurred_at)
            .fetch_optional(&mut *transaction)
            .await?;
        let period_start: OffsetDateTime = match &budget {
            Some(row) => row.try_get("billing_period_start")?,
            None => sqlx::query_scalar(
                "SELECT billing_period_start FROM entitlement_snapshots WHERE billing_period_start <= $1 AND billing_period_end > $1 ORDER BY version DESC LIMIT 1",
            )
            .bind(occurred_at)
            .fetch_optional(&mut *transaction)
            .await?
            .unwrap_or_else(|| month_start(occurred_at)),
        };
        sqlx::query(
            "INSERT INTO usage_aggregates (tenant_id, billing_period_start, metric, quantity, cost_usd_micros, event_count, last_event_occurred_at) \
             VALUES ($1, $2, $3, $4, $5, 1, $6) \
             ON CONFLICT (tenant_id, billing_period_start, metric) DO UPDATE SET \
               quantity = usage_aggregates.quantity + EXCLUDED.quantity, \
               cost_usd_micros = usage_aggregates.cost_usd_micros + EXCLUDED.cost_usd_micros, \
               event_count = usage_aggregates.event_count + 1, \
               last_event_occurred_at = greatest(usage_aggregates.last_event_occurred_at, EXCLUDED.last_event_occurred_at), \
               updated_at = now()",
        )
        .bind(record.tenant_id)
        .bind(period_start)
        .bind(&record.metric)
        .bind(record.quantity)
        .bind(to_i64(cost))
        .bind(occurred_at)
        .execute(&mut *transaction)
        .await?;
        let mut hard_cap_reached = false;
        if let Some(row) = budget {
            let state = budget_state(&row)?;
            hard_cap_reached = state.hard_cap_reached;
            if cost > 0 {
                let daily = Self::daily_spend(&mut transaction, prices, day_start(occurred_at)).await?;
                let decision = apply_cost(&state, cost, daily);
                let id: Uuid = row.try_get("id")?;
                sqlx::query(
                    "UPDATE cost_budgets SET consumed_usd_micros = $2, unlocked_quarters = $3, \
                       soft_warning_sent_at = CASE WHEN $4 THEN coalesce(soft_warning_sent_at, now()) ELSE soft_warning_sent_at END, \
                       hard_cap_reached_at = CASE WHEN $5 THEN coalesce(hard_cap_reached_at, now()) ELSE hard_cap_reached_at END, \
                       updated_at = now(), version = version + 1 \
                     WHERE id = $1",
                )
                .bind(id)
                .bind(to_i64(decision.consumed_usd_micros))
                .bind(i16::from(decision.unlocked_quarters))
                .bind(decision.set_soft_warning)
                .bind(decision.set_hard_cap)
                .execute(&mut *transaction)
                .await?;
                hard_cap_reached = hard_cap_reached || decision.set_hard_cap;
            }
        }
        transaction.commit().await?;
        Ok(RecordOutcome::Recorded { cost_usd_micros: cost, unpriced: pricing == Pricing::Unpriced, hard_cap_reached })
    }

    pub async fn tenants(&self) -> Result<Vec<Uuid>, StoreError> {
        Ok(sqlx::query_scalar("SELECT id FROM tenant_directory").fetch_all(&self.pool).await?)
    }

    pub async fn release_daily_cap(&self, tenant_id: Uuid, now: OffsetDateTime, prices: &PriceTable) -> Result<bool, StoreError> {
        let mut transaction = self.begin_tenant(tenant_id).await?;
        let row = sqlx::query(CAPPED_BUDGET_FOR_PERIOD)
        .bind(now)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            transaction.rollback().await?;
            return Ok(false);
        };
        let state = budget_state(&row)?;
        let reached_at: OffsetDateTime = row.try_get("hard_cap_reached_at")?;
        let today = day_start(now);
        let daily = Self::daily_spend(&mut transaction, prices, today).await?;
        if !should_release_daily_cap(&state, daily, reached_at < today) {
            transaction.rollback().await?;
            return Ok(false);
        }
        let id: Uuid = row.try_get("id")?;
        sqlx::query("UPDATE cost_budgets SET hard_cap_reached_at = NULL, updated_at = now(), version = version + 1 WHERE id = $1")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    const PRICES: &str = r#"{"gpt-5.6-luna":{"input_usd_micros_per_million":200000,"output_usd_micros_per_million":1200000}}"#;

    struct Fixture {
        admin: PgPool,
        store: Store,
        prices: PriceTable,
    }

    async fn fixture() -> Result<Fixture, Box<dyn std::error::Error>> {
        let url = std::env::var("VELYRIC_TEST_DATABASE_URL")?;
        let admin = PgPoolOptions::new().max_connections(2).connect_with(PgConnectOptions::from_str(&url)?.options([("search_path", "app,public")])).await?;
        let store = Store::connect(&url, Some("velyric_metering"), 2).await?;
        Ok(Fixture { admin, store, prices: PriceTable::parse(PRICES)? })
    }

    async fn tenant(admin: &PgPool) -> Result<Uuid, sqlx::Error> {
        let slug = format!("metering-{}", Uuid::now_v7().simple());
        sqlx::query_scalar("INSERT INTO app.tenants (legal_name, display_name, slug) VALUES ('Metering Kft.', 'Metering', $1) RETURNING id")
            .bind(slug)
            .fetch_one(admin)
            .await
    }

    async fn call(admin: &PgPool, tenant_id: Uuid) -> Result<Uuid, sqlx::Error> {
        sqlx::query_scalar(
            "INSERT INTO app.calls (tenant_id, channel, direction, provider, provider_call_id, started_at, trace_id) \
             VALUES ($1, 'PSTN', 'INBOUND', 'openai', $2, now(), $3) RETURNING id",
        )
        .bind(tenant_id)
        .bind(format!("sess_{}", Uuid::now_v7().simple()))
        .bind(Uuid::new_v4().simple().to_string())
        .fetch_one(admin)
        .await
    }

    async fn budget(admin: &PgPool, tenant_id: Uuid, period_budget: i64, daily_cap: i64, monthly_cap: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO app.cost_budgets (tenant_id, billing_period_start, billing_period_end, period_budget_usd_micros, daily_cap_usd_micros, monthly_cap_usd_micros) \
             VALUES ($1, now() - interval '10 days', now() + interval '20 days', $2, $3, $4)",
        )
        .bind(tenant_id)
        .bind(period_budget)
        .bind(daily_cap)
        .bind(monthly_cap)
        .execute(admin)
        .await
        .map(|_| ())
    }

    fn usage(tenant_id: Uuid, call_id: Option<Uuid>, metric: &str, quantity: i64, unit: &str, model: Option<&str>) -> UsageRecord {
        UsageRecord {
            source_event_id: Uuid::now_v7(),
            tenant_id,
            call_id,
            metric: metric.into(),
            quantity,
            unit: unit.into(),
            provider: Some("openai".into()),
            model: model.map(str::to_owned),
            occurred_at: String::new(),
        }
    }

    #[tokio::test]
    #[ignore = "requires VELYRIC_TEST_DATABASE_URL (pnpm --filter @velyric/db test-server); runs in CI"]
    async fn records_usage_idempotently_aggregates_and_prices_backend_tokens() -> TestResult {
        let fixture = fixture().await?;
        let tenant_id = tenant(&fixture.admin).await?;
        let call_id = call(&fixture.admin, tenant_id).await?;
        budget(&fixture.admin, tenant_id, 10_000_000, 5_000_000, 20_000_000).await?;
        let now = OffsetDateTime::now_utc();
        let voice = usage(tenant_id, Some(call_id), "live_voice_cost", 35_000, "USD_MICROS", Some("gpt-live-1"));
        assert_eq!(
            fixture.store.record_usage(&voice, now, &fixture.prices).await?,
            RecordOutcome::Recorded { cost_usd_micros: 35_000, unpriced: false, hard_cap_reached: false }
        );
        assert_eq!(fixture.store.record_usage(&voice, now, &fixture.prices).await?, RecordOutcome::Duplicate);
        let tokens = usage(tenant_id, Some(call_id), "backend_input_tokens", 1_200_000, "TOKENS", Some("gpt-5.6-luna"));
        assert_eq!(
            fixture.store.record_usage(&tokens, now, &fixture.prices).await?,
            RecordOutcome::Recorded { cost_usd_micros: 240_000, unpriced: false, hard_cap_reached: false }
        );
        let unpriced = usage(tenant_id, Some(call_id), "backend_output_tokens", 10, "TOKENS", Some("gpt-unknown"));
        assert_eq!(
            fixture.store.record_usage(&unpriced, now, &fixture.prices).await?,
            RecordOutcome::Recorded { cost_usd_micros: 0, unpriced: true, hard_cap_reached: false }
        );
        let aggregates: Vec<(String, i64, i64, i64)> =
            sqlx::query_as("SELECT metric, quantity, cost_usd_micros, event_count FROM app.usage_aggregates WHERE tenant_id = $1 ORDER BY metric")
                .bind(tenant_id)
                .fetch_all(&fixture.admin)
                .await?;
        assert_eq!(
            aggregates,
            vec![
                ("backend_input_tokens".to_owned(), 1_200_000, 240_000, 1),
                ("backend_output_tokens".to_owned(), 10, 0, 1),
                ("live_voice_cost".to_owned(), 35_000, 35_000, 1)
            ]
        );
        let consumed: i64 = sqlx::query_scalar("SELECT consumed_usd_micros FROM app.cost_budgets WHERE tenant_id = $1").bind(tenant_id).fetch_one(&fixture.admin).await?;
        assert_eq!(consumed, 275_000);
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires VELYRIC_TEST_DATABASE_URL (pnpm --filter @velyric/db test-server); runs in CI"]
    async fn spend_unlocks_quarters_trips_hard_caps_and_releases_daily_caps_on_a_new_day() -> TestResult {
        let fixture = fixture().await?;
        let tenant_id = tenant(&fixture.admin).await?;
        budget(&fixture.admin, tenant_id, 1_000_000, 800_000, 900_000).await?;
        let now = OffsetDateTime::now_utc();
        fixture.store.record_usage(&usage(tenant_id, None, "live_voice_cost", 250_000, "USD_MICROS", None), now, &fixture.prices).await?;
        let (unlocked, hard): (i16, bool) =
            sqlx::query_as("SELECT unlocked_quarters, hard_cap_reached_at IS NOT NULL FROM app.cost_budgets WHERE tenant_id = $1").bind(tenant_id).fetch_one(&fixture.admin).await?;
        assert_eq!((unlocked, hard), (2, false));
        let outcome = fixture.store.record_usage(&usage(tenant_id, None, "tool_external_cost", 600_000, "USD_MICROS", None), now, &fixture.prices).await?;
        assert_eq!(outcome, RecordOutcome::Recorded { cost_usd_micros: 600_000, unpriced: false, hard_cap_reached: true });
        let (unlocked, soft, hard): (i16, bool, bool) = sqlx::query_as(
            "SELECT unlocked_quarters, soft_warning_sent_at IS NOT NULL, hard_cap_reached_at IS NOT NULL FROM app.cost_budgets WHERE tenant_id = $1",
        )
        .bind(tenant_id)
        .fetch_one(&fixture.admin)
        .await?;
        assert_eq!((unlocked, soft, hard), (4, true, true));
        assert!(!fixture.store.release_daily_cap(tenant_id, now, &fixture.prices).await?);
        sqlx::query("UPDATE app.cost_budgets SET hard_cap_reached_at = now() - interval '1 day' WHERE tenant_id = $1").bind(tenant_id).execute(&fixture.admin).await?;
        let released = fixture.store.release_daily_cap(tenant_id, now + time::Duration::days(1), &fixture.prices).await?;
        assert!(released);
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires VELYRIC_TEST_DATABASE_URL (pnpm --filter @velyric/db test-server); runs in CI"]
    async fn row_level_security_isolates_tenants_and_errors_are_classified() -> TestResult {
        let fixture = fixture().await?;
        let first = tenant(&fixture.admin).await?;
        let second = tenant(&fixture.admin).await?;
        fixture.store.record_usage(&usage(first, None, "email_count", 1, "COUNT", None), OffsetDateTime::now_utc(), &fixture.prices).await?;
        let mut transaction = fixture.store.begin_tenant(second).await?;
        let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_events WHERE tenant_id = $1").bind(first).fetch_one(&mut *transaction).await?;
        transaction.rollback().await?;
        assert_eq!(visible, 0);
        let missing_call = usage(first, Some(Uuid::now_v7()), "connected_voice_seconds", 10, "SECONDS", None);
        assert!(matches!(
            fixture.store.record_usage(&missing_call, OffsetDateTime::now_utc(), &fixture.prices).await,
            Err(StoreError::MissingReference(_))
        ));
        let negative = usage(first, None, "email_count", -1, "COUNT", None);
        assert!(matches!(fixture.store.record_usage(&negative, OffsetDateTime::now_utc(), &fixture.prices).await, Err(StoreError::Invalid(_))));
        let foreign = UsageRecord { tenant_id: second, ..usage(first, None, "email_count", 1, "COUNT", None) };
        let mut transaction = fixture.store.begin_tenant(first).await?;
        let forged = sqlx::query("INSERT INTO usage_events (tenant_id, metric, quantity, unit, source_event_id, occurred_at) VALUES ($1, 'email_count', 1, 'count', $2, now())")
            .bind(foreign.tenant_id)
            .bind(foreign.source_event_id)
            .execute(&mut *transaction)
            .await;
        transaction.rollback().await?;
        assert!(forged.is_err());
        Ok(())
    }

    #[test]
    fn day_and_month_boundaries_are_utc() -> Result<(), time::error::ComponentRange> {
        let value = OffsetDateTime::from_unix_timestamp(1_789_400_000)?.to_offset(UtcOffset::from_hms(2, 0, 0)?);
        assert_eq!(day_start(value).offset(), UtcOffset::UTC);
        assert_eq!(day_start(value).time(), Time::MIDNIGHT);
        assert_eq!(month_start(value).day(), 1);
        Ok(())
    }
}
