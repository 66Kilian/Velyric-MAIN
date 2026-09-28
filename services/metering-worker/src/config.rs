use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};

use uuid::Uuid;
pub use velyric_service_kit::env::{ConfigError, EnvReader, Environment, SecretSource, valid_token};

use crate::pricing::PriceTable;

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub environment: Environment,
    pub aws_region: String,
    pub instance_id: String,
    pub log_level: String,
    pub host: IpAddr,
    pub port: u16,
    pub database_url: SecretSource,
    pub database_role: Option<String>,
    pub database_max_connections: u32,
    pub nats_url: String,
    pub nats_creds: Option<SecretSource>,
    pub stream_replicas: usize,
    pub max_deliver: i64,
    pub token_prices: PriceTable,
}

pub fn load(env: &HashMap<String, String>) -> Result<WorkerConfig, ConfigError> {
    let mut reader = EnvReader::new(env);
    let environment = reader.environment();
    let aws_region = reader.region();
    let deployed = environment.is_some_and(Environment::is_deployed);
    let instance_id = reader.optional("VELYRIC_SERVICE_INSTANCE_ID").unwrap_or_else(|| format!("metering-worker-{}", Uuid::now_v7()));
    if !valid_token(&instance_id, 128) || instance_id.contains([':', '.']) {
        reader.issue("VELYRIC_SERVICE_INSTANCE_ID may only contain letters, digits, '-' and '_'");
    }
    let log_level = reader.optional("VELYRIC_LOG_LEVEL").unwrap_or_else(|| "info".to_owned());
    let host = match reader.optional("METERING_WORKER_HOST") {
        Some(raw) => raw.parse::<IpAddr>().unwrap_or_else(|_| {
            reader.issue("METERING_WORKER_HOST must be an IP address");
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        }),
        None if deployed => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        None => IpAddr::V4(Ipv4Addr::LOCALHOST),
    };
    let port = reader.number("METERING_WORKER_PORT", 7_100_u16, 1, u16::MAX);
    let database_url = reader.secret("VELYRIC_DATABASE_URL", environment, true);
    let assume_role = match reader.optional("METERING_WORKER_DATABASE_ASSUME_ROLE").as_deref() {
        Some("true") => true,
        Some("false") => false,
        Some(_) => {
            reader.issue("METERING_WORKER_DATABASE_ASSUME_ROLE must be true or false");
            false
        }
        None => environment == Some(Environment::Local),
    };
    let database_max_connections = reader.number("METERING_WORKER_DATABASE_MAX_CONNECTIONS", 8_u32, 1, 64);
    let nats_url = reader.required("VELYRIC_NATS_URL").filter(|url| {
        let valid = url.split(',').all(|part| {
            let part = part.trim();
            part.starts_with("tls://") || (!deployed && part.starts_with("nats://"))
        });
        if !valid {
            reader.issue("VELYRIC_NATS_URL must use tls:// (nats:// is allowed only in local and ci)");
        }
        valid
    });
    let nats_creds = reader.secret("VELYRIC_NATS_CREDS", environment, deployed);
    let stream_replicas = reader.number("METERING_WORKER_STREAM_REPLICAS", if deployed { 3_usize } else { 1 }, 1, 5);
    let max_deliver = reader.number("METERING_WORKER_MAX_DELIVER", 20_i64, 2, 1_000);
    let token_prices = reader.required("METERING_WORKER_TOKEN_PRICES").and_then(|raw| match PriceTable::parse(&raw) {
        Ok(table) => Some(table),
        Err(error) => {
            reader.issue(format!("METERING_WORKER_TOKEN_PRICES: {error}"));
            None
        }
    });
    if reader.has_issues() {
        return Err(reader.into_error());
    }
    let (Some(environment), Some(aws_region), Some(database_url), Some(nats_url), Some(token_prices)) =
        (environment, aws_region, database_url, nats_url, token_prices)
    else {
        return Err(ConfigError(vec!["configuration is incomplete".to_owned()]));
    };
    Ok(WorkerConfig {
        environment,
        aws_region,
        instance_id,
        log_level,
        host,
        port,
        database_url,
        database_role: assume_role.then(|| "velyric_metering".to_owned()),
        database_max_connections,
        nats_url,
        nats_creds,
        stream_replicas,
        max_deliver,
        token_prices,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local() -> HashMap<String, String> {
        [
            ("VELYRIC_ENV", "local"),
            ("VELYRIC_AWS_REGION", "eu-central-1"),
            ("VELYRIC_DATABASE_URL_SECRET", "postgres://velyric_metering:pw@127.0.0.1:55432/velyric"),
            ("VELYRIC_NATS_URL", "nats://127.0.0.1:54222"),
            ("METERING_WORKER_TOKEN_PRICES", r#"{"gpt-5.6-luna":{"input_usd_micros_per_million":200000,"output_usd_micros_per_million":1200000}}"#),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
    }

    #[test]
    fn loads_local_defaults_with_role_assumption() -> Result<(), ConfigError> {
        let config = load(&local())?;
        assert_eq!(config.port, 7_100);
        assert_eq!(config.stream_replicas, 1);
        assert_eq!(config.max_deliver, 20);
        assert_eq!(config.database_role.as_deref(), Some("velyric_metering"));
        assert!(config.token_prices.price("gpt-5.6-luna").is_some());
        Ok(())
    }

    #[test]
    fn production_rejects_inline_secrets_plaintext_nats_and_bad_prices() {
        let mut env = local();
        env.insert("VELYRIC_ENV".into(), "production".into());
        env.insert("METERING_WORKER_TOKEN_PRICES".into(), "{}".into());
        let Err(ConfigError(issues)) = load(&env) else {
            panic!("invalid production configuration must be rejected");
        };
        let joined = issues.join("\n");
        assert!(joined.contains("VELYRIC_DATABASE_URL_SECRET is not allowed in production"));
        assert!(joined.contains("VELYRIC_NATS_URL must use tls://"));
        assert!(joined.contains("VELYRIC_NATS_CREDS_SECRET or VELYRIC_NATS_CREDS_SECRET_ARN is required"));
        assert!(joined.contains("METERING_WORKER_TOKEN_PRICES"));
    }
}
