use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use url::Url;
use uuid::Uuid;
pub use velyric_service_kit::env::{ConfigError, EnvReader, Environment, ProviderMode, SecretSource, valid_region, valid_token};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCatalog {
    pub live: String,
    pub routine: String,
    pub complex: String,
    pub escalation: String,
    pub frontier: String,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub environment: Environment,
    pub aws_region: String,
    pub instance_id: String,
    pub log_level: String,
    pub host: IpAddr,
    pub public_port: u16,
    pub admin_port: u16,
    pub drain_timeout: Duration,
    pub fallback_max_calls_per_tenant: u32,
    pub global_max_calls: u32,
    pub provider_max_calls: u32,
    pub admission_lease: Duration,
    pub redis_url: String,
    pub nats_url: String,
    pub nats_creds: Option<SecretSource>,
    pub control_api_url: Url,
    pub service_key_id: String,
    pub service_signing_key: SecretSource,
    pub service_jwks_url: Url,
    pub openai_mode: ProviderMode,
    pub openai_api_base: Url,
    pub openai_webhook_secret: SecretSource,
    pub openai_platform_api_key: SecretSource,
    pub models: ModelCatalog,
    pub live_usd_micros_per_minute: u64,
    pub backend_max_output_tokens: u32,
}

fn model(reader: &mut EnvReader<'_>, name: &str, default: Option<&str>) -> Option<String> {
    let value = match default {
        Some(default) => Some(reader.optional(name).unwrap_or_else(|| default.to_owned())),
        None => reader.required(name),
    }?;
    if valid_token(&value, 100) {
        Some(value)
    } else {
        reader.issue(format!("{name} must be a model identifier"));
        None
    }
}

pub fn load(env: &HashMap<String, String>) -> Result<RuntimeConfig, ConfigError> {
    let mut reader = EnvReader::new(env);
    let environment = reader.required("VELYRIC_ENV").and_then(|raw| {
        let parsed = Environment::parse(&raw);
        if parsed.is_none() {
            reader.issue("VELYRIC_ENV must be one of local, ci, staging, production".to_owned());
        }
        parsed
    });
    let aws_region = reader.required("VELYRIC_AWS_REGION").filter(|region| {
        let valid = valid_region(region);
        if !valid {
            reader.issue("VELYRIC_AWS_REGION must be an AWS region such as eu-central-1".to_owned());
        }
        valid
    });
    let instance_id = reader.optional("VELYRIC_SERVICE_INSTANCE_ID").unwrap_or_else(|| format!("voice-runtime-{}", Uuid::now_v7()));
    if !valid_token(&instance_id, 128) || instance_id.contains([':', '.']) {
        reader.issue("VELYRIC_SERVICE_INSTANCE_ID may only contain letters, digits, '-' and '_'".to_owned());
    }
    let log_level = reader.optional("VELYRIC_LOG_LEVEL").unwrap_or_else(|| "info".to_owned());
    let deployed = environment.is_some_and(Environment::is_deployed);
    let host = match reader.optional("VOICE_RUNTIME_HOST") {
        Some(raw) => raw.parse::<IpAddr>().unwrap_or_else(|_| {
            reader.issue("VOICE_RUNTIME_HOST must be an IP address".to_owned());
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        }),
        None if deployed => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        None => IpAddr::V4(Ipv4Addr::LOCALHOST),
    };
    let public_port = reader.number("VOICE_RUNTIME_PUBLIC_PORT", 7000_u16, 1, u16::MAX);
    let admin_port = reader.number("VOICE_RUNTIME_ADMIN_PORT", 7001_u16, 1, u16::MAX);
    if public_port == admin_port {
        reader.issue("VOICE_RUNTIME_PUBLIC_PORT and VOICE_RUNTIME_ADMIN_PORT must differ".to_owned());
    }
    let drain_timeout = Duration::from_secs(reader.number("VOICE_RUNTIME_DRAIN_TIMEOUT_SECONDS", 1_800_u64, 1, 7_200));
    let fallback_max_calls_per_tenant = reader.number("VOICE_RUNTIME_FALLBACK_MAX_CALLS_PER_TENANT", 1_u32, 1, 32);
    let global_max_calls = reader.number("VOICE_RUNTIME_GLOBAL_MAX_CALLS", 1_000_u32, 1, 100_000);
    let provider_max_calls = reader.number("VOICE_RUNTIME_PROVIDER_MAX_CALLS", 1_000_u32, 1, 100_000);
    let admission_lease = Duration::from_secs(reader.number("VOICE_RUNTIME_ADMISSION_LEASE_SECONDS", 30_u64, 10, 300));
    let redis_url = reader.required("VELYRIC_REDIS_URL").filter(|url| {
        let valid = url.starts_with("rediss://") || (!deployed && url.starts_with("redis://"));
        if !valid {
            reader.issue("VELYRIC_REDIS_URL must use rediss:// (redis:// is allowed only in local and ci)".to_owned());
        }
        valid
    });
    let nats_url = reader.required("VELYRIC_NATS_URL").filter(|url| {
        let valid = url.split(',').all(|part| {
            let part = part.trim();
            part.starts_with("tls://") || (!deployed && part.starts_with("nats://"))
        });
        if !valid {
            reader.issue("VELYRIC_NATS_URL must use tls:// (nats:// is allowed only in local and ci)".to_owned());
        }
        valid
    });
    let nats_creds = reader.secret("VELYRIC_NATS_CREDS", environment, deployed);
    let control_api_raw = reader.required("VELYRIC_CONTROL_API_INTERNAL_URL");
    let control_api_url = reader.url("VELYRIC_CONTROL_API_INTERNAL_URL", control_api_raw);
    let service_key_id = reader.required("VOICE_RUNTIME_SERVICE_KEY_ID").filter(|kid| {
        let valid = valid_token(kid, 64);
        if !valid {
            reader.issue("VOICE_RUNTIME_SERVICE_KEY_ID must be a key identifier".to_owned());
        }
        valid
    });
    let service_signing_key = reader.secret("VELYRIC_SERVICE_SIGNING_KEY", environment, true);
    let jwks_raw = reader.required("VELYRIC_SERVICE_JWKS_URL");
    let service_jwks_url = reader.url("VELYRIC_SERVICE_JWKS_URL", jwks_raw);
    let openai_mode = match reader.optional("VELYRIC_PROVIDER_MODE_OPENAI") {
        Some(raw) => {
            let parsed = ProviderMode::parse(&raw);
            if parsed.is_none() {
                reader.issue("VELYRIC_PROVIDER_MODE_OPENAI must be one of simulator, sandbox, live".to_owned());
            }
            parsed
        }
        None => environment.map(ProviderMode::default_for),
    };
    if let (Some(environment), Some(mode)) = (environment, openai_mode)
        && !mode.allowed_in(environment)
    {
        reader.issue(format!("VELYRIC_PROVIDER_MODE_OPENAI={} is not allowed in {}", mode.as_str(), environment.as_str()));
    }
    let openai_api_base = match (openai_mode, reader.optional("VOICE_RUNTIME_OPENAI_API_BASE_URL")) {
        (_, Some(raw)) => reader.url("VOICE_RUNTIME_OPENAI_API_BASE_URL", Some(raw)),
        (Some(ProviderMode::Simulator), None) => {
            let simulator = reader.required("VELYRIC_PROVIDER_SIMULATOR_URL");
            reader.url("VELYRIC_PROVIDER_SIMULATOR_URL", simulator).and_then(|url| url.join("openai/v1").ok())
        }
        _ => Url::parse("https://api.openai.com/v1").ok(),
    };
    if matches!(openai_mode, Some(ProviderMode::Sandbox | ProviderMode::Live))
        && openai_api_base.as_ref().is_some_and(|url| url.scheme() != "https")
    {
        reader.issue("VOICE_RUNTIME_OPENAI_API_BASE_URL must use https outside simulator mode".to_owned());
    }
    let openai_webhook_secret = reader.secret("VELYRIC_OPENAI_WEBHOOK", environment, true);
    let openai_platform_api_key = reader.secret("VOICE_RUNTIME_OPENAI_API_KEY", environment, true);
    let models = (
        model(&mut reader, "VOICE_RUNTIME_MODEL_LIVE", Some("gpt-live-1")),
        model(&mut reader, "VOICE_RUNTIME_MODEL_ROUTINE", None),
        model(&mut reader, "VOICE_RUNTIME_MODEL_COMPLEX", None),
        model(&mut reader, "VOICE_RUNTIME_MODEL_ESCALATION", None),
        model(&mut reader, "VOICE_RUNTIME_MODEL_FRONTIER", None),
    );
    let live_usd_micros_per_minute = reader.number("VOICE_RUNTIME_LIVE_USD_MICROS_PER_MINUTE", 50_000_u64, 1, 10_000_000);
    let backend_max_output_tokens = reader.number("VOICE_RUNTIME_BACKEND_MAX_OUTPUT_TOKENS", 1_024_u32, 64, 32_000);

    if reader.has_issues() {
        return Err(reader.into_error());
    }
    let (
        Some(environment),
        Some(aws_region),
        Some(redis_url),
        Some(nats_url),
        Some(control_api_url),
        Some(service_key_id),
        Some(service_signing_key),
        Some(service_jwks_url),
        Some(openai_mode),
        Some(openai_api_base),
        Some(openai_webhook_secret),
        Some(openai_platform_api_key),
        (Some(live), Some(routine), Some(complex), Some(escalation), Some(frontier)),
    ) = (
        environment,
        aws_region,
        redis_url,
        nats_url,
        control_api_url,
        service_key_id,
        service_signing_key,
        service_jwks_url,
        openai_mode,
        openai_api_base,
        openai_webhook_secret,
        openai_platform_api_key,
        models,
    )
    else {
        return Err(ConfigError(vec!["configuration is incomplete".to_owned()]));
    };
    Ok(RuntimeConfig {
        environment,
        aws_region,
        instance_id,
        log_level,
        host,
        public_port,
        admin_port,
        drain_timeout,
        fallback_max_calls_per_tenant,
        global_max_calls,
        provider_max_calls,
        admission_lease,
        redis_url,
        nats_url,
        nats_creds,
        control_api_url,
        service_key_id,
        service_signing_key,
        service_jwks_url,
        openai_mode,
        openai_api_base,
        openai_webhook_secret,
        openai_platform_api_key,
        models: ModelCatalog { live, routine, complex, escalation, frontier },
        live_usd_micros_per_minute,
        backend_max_output_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local() -> HashMap<String, String> {
        [
            ("VELYRIC_ENV", "local"),
            ("VELYRIC_AWS_REGION", "eu-central-1"),
            ("VELYRIC_REDIS_URL", "redis://127.0.0.1:56379"),
            ("VELYRIC_NATS_URL", "nats://127.0.0.1:54222"),
            ("VELYRIC_CONTROL_API_INTERNAL_URL", "http://127.0.0.1:4001"),
            ("VOICE_RUNTIME_SERVICE_KEY_ID", "voice-runtime-local-1"),
            ("VELYRIC_SERVICE_SIGNING_KEY_SECRET", "-----BEGIN PRIVATE KEY-----"),
            ("VELYRIC_SERVICE_JWKS_URL", "http://127.0.0.1:4001/internal/v1/.well-known/jwks.json"),
            ("VELYRIC_PROVIDER_SIMULATOR_URL", "http://127.0.0.1:4010"),
            ("VELYRIC_OPENAI_WEBHOOK_SECRET", "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"),
            ("VOICE_RUNTIME_OPENAI_API_KEY_SECRET", "sk-simulator-voice"),
            ("VOICE_RUNTIME_MODEL_ROUTINE", "gpt-5.6-luna"),
            ("VOICE_RUNTIME_MODEL_COMPLEX", "gpt-5.6-terra"),
            ("VOICE_RUNTIME_MODEL_ESCALATION", "gpt-5.6-sol"),
            ("VOICE_RUNTIME_MODEL_FRONTIER", "gpt-6-astra"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
    }

    #[test]
    fn loads_a_local_simulator_configuration_with_defaults() -> Result<(), ConfigError> {
        let config = load(&local())?;
        assert_eq!(config.environment, Environment::Local);
        assert_eq!(config.openai_mode, ProviderMode::Simulator);
        assert_eq!(config.openai_api_base.as_str(), "http://127.0.0.1:4010/openai/v1");
        assert_eq!((config.public_port, config.admin_port), (7000, 7001));
        assert_eq!(config.drain_timeout, Duration::from_secs(1_800));
        assert_eq!(config.fallback_max_calls_per_tenant, 1);
        assert_eq!(config.models.live, "gpt-live-1");
        assert_eq!(config.live_usd_micros_per_minute, 50_000);
        assert_eq!(config.host, IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert!(config.instance_id.starts_with("voice-runtime-"));
        assert_eq!(format!("{:?}", config.service_signing_key), "SecretSource::Inline(redacted)");
        Ok(())
    }

    #[test]
    fn production_requires_secret_arns_tls_transports_and_live_mode() {
        let mut env = local();
        env.insert("VELYRIC_ENV".into(), "production".into());
        env.insert("VELYRIC_PROVIDER_MODE_OPENAI".into(), "sandbox".into());
        let Err(ConfigError(issues)) = load(&env) else {
            panic!("production configuration with inline secrets must be rejected");
        };
        let joined = issues.join("\n");
        assert!(joined.contains("VELYRIC_SERVICE_SIGNING_KEY_SECRET is not allowed in production"));
        assert!(joined.contains("VELYRIC_OPENAI_WEBHOOK_SECRET is not allowed in production"));
        assert!(joined.contains("VELYRIC_REDIS_URL must use rediss://"));
        assert!(joined.contains("VELYRIC_NATS_URL must use tls://"));
        assert!(joined.contains("VELYRIC_PROVIDER_MODE_OPENAI=sandbox is not allowed in production"));
        assert!(joined.contains("VELYRIC_NATS_CREDS_SECRET or VELYRIC_NATS_CREDS_SECRET_ARN is required"));
    }

    #[test]
    fn accepts_a_complete_production_configuration() -> Result<(), ConfigError> {
        let mut env = local();
        for key in ["VELYRIC_SERVICE_SIGNING_KEY_SECRET", "VELYRIC_OPENAI_WEBHOOK_SECRET", "VELYRIC_PROVIDER_SIMULATOR_URL", "VOICE_RUNTIME_OPENAI_API_KEY_SECRET"] {
            env.remove(key);
        }
        for (key, value) in [
            ("VELYRIC_ENV", "production"),
            ("VELYRIC_REDIS_URL", "rediss://redis.internal:6379"),
            ("VELYRIC_NATS_URL", "tls://nats-1.internal:4222,tls://nats-2.internal:4222"),
            ("VELYRIC_NATS_CREDS_SECRET_ARN", "arn:aws:secretsmanager:eu-central-1:123456789012:secret:nats/creds"),
            ("VELYRIC_SERVICE_SIGNING_KEY_SECRET_ARN", "arn:aws:secretsmanager:eu-central-1:123456789012:secret:voice-runtime/signing"),
            ("VELYRIC_OPENAI_WEBHOOK_SECRET_ARN", "arn:aws:secretsmanager:eu-central-1:123456789012:secret:openai/webhook-secret"),
            ("VOICE_RUNTIME_OPENAI_API_KEY_SECRET_ARN", "arn:aws:secretsmanager:eu-central-1:123456789012:secret:openai/voice-platform-key"),
        ] {
            env.insert(key.into(), value.into());
        }
        let config = load(&env)?;
        assert_eq!(config.openai_mode, ProviderMode::Live);
        assert_eq!(config.openai_api_base.as_str(), "https://api.openai.com/v1");
        assert_eq!(config.host, IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert!(matches!(config.openai_webhook_secret, SecretSource::Arn(_)));
        Ok(())
    }

    #[test]
    fn reports_every_missing_or_malformed_value_at_once() {
        let mut env = local();
        env.remove("VOICE_RUNTIME_MODEL_ROUTINE");
        env.insert("VELYRIC_AWS_REGION".into(), "europe".into());
        env.insert("VOICE_RUNTIME_ADMIN_PORT".into(), "7000".into());
        env.insert("VELYRIC_OPENAI_WEBHOOK_SECRET_ARN".into(), "arn:aws:secretsmanager:eu-central-1:1:secret:x".into());
        env.insert("VOICE_RUNTIME_DRAIN_TIMEOUT_SECONDS".into(), "0".into());
        let Err(ConfigError(issues)) = load(&env) else {
            panic!("invalid configuration must be rejected");
        };
        assert_eq!(issues.len(), 5, "{issues:?}");
    }
}
