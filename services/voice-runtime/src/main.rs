#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use redis::aio::ConnectionManager;
use secrecy::ExposeSecret;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use url::Url;
use velyric_common_observability::TelemetryConfig;
use velyric_runtime_policy::admission::RedisAdmissionStore;
use velyric_runtime_policy::service_auth::{ServiceSigner, ServiceVerifier};
use velyric_voice_runtime::admission::{AdmissionGate, AdmissionLimits};
use velyric_voice_runtime::commands::{self, CommandContext, ReplayGuard};
use velyric_voice_runtime::config::{self, ProviderMode, RuntimeConfig};
use velyric_voice_runtime::control_api::ControlApiClient;
use velyric_voice_runtime::incoming::{RuntimeSettings, RuntimeState};
use velyric_voice_runtime::metrics::Metrics;
use velyric_voice_runtime::openai::OpenAiLiveClient;
use velyric_voice_runtime::registry::{Registry, SessionCommand, ShutdownReason};
use velyric_voice_runtime::secrets::SecretResolver;
use velyric_voice_runtime::server::{AdminState, admin_router, public_router};
use velyric_voice_runtime::session::SessionTiming;
use velyric_voice_runtime::webhook_signature::WebhookSecret;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

#[tokio::main]
async fn main() -> ExitCode {
    let env: HashMap<String, String> = std::env::vars().collect();
    let config = match config::load(&env) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(78);
        }
    };
    let telemetry = TelemetryConfig {
        service_name: "voice-runtime",
        service_version: env!("CARGO_PKG_VERSION"),
        environment: config.environment.as_str().to_owned(),
        log_level: config.log_level.clone(),
        json: config.environment.is_deployed(),
    };
    if let Err(error) = velyric_common_observability::init(&telemetry) {
        eprintln!("{error}");
        return ExitCode::from(78);
    }
    velyric_voice_runtime::install_crypto_provider();
    match run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            error!(error = %error, "voice runtime stopped");
            ExitCode::FAILURE
        }
    }
}

async fn fetch_jwks(http: &reqwest::Client, url: &Url) -> Result<String, BoxError> {
    let mut last_error: Option<reqwest::Error> = None;
    for attempt in 0..5_u32 {
        match http.get(url.clone()).send().await.and_then(reqwest::Response::error_for_status) {
            Ok(response) => return Ok(response.text().await?),
            Err(error) => {
                last_error = Some(error.without_url());
                tokio::time::sleep(Duration::from_millis(500 * 2_u64.pow(attempt))).await;
            }
        }
    }
    Err(last_error.map_or_else(|| BoxError::from("service JWKS unavailable"), BoxError::from))
}

async fn connect_redis(config: &RuntimeConfig) -> Result<(Option<ConnectionManager>, Option<RedisAdmissionStore>), BoxError> {
    let client = redis::Client::open(config.redis_url.as_str())?;
    let manager = tokio::time::timeout(Duration::from_secs(5), client.get_connection_manager()).await;
    let store = RedisAdmissionStore::connect(&config.redis_url).await;
    match (manager, store) {
        (Ok(Ok(manager)), Ok(store)) => Ok((Some(manager), Some(store))),
        (manager, store) => {
            let detail = match (manager, store) {
                (Ok(Err(error)), _) => error.to_string(),
                (Err(_), _) => "connection timed out".to_owned(),
                (_, Err(error)) => error.to_string(),
                _ => "unknown".to_owned(),
            };
            if config.environment.is_deployed() {
                return Err(format!("redis unavailable: {detail}").into());
            }
            warn!(%detail, "redis unavailable; running with per-instance admission and caches");
            Ok((None, None))
        }
    }
}

async fn wait_for_drain_trigger(registry: &Registry) {
    let admin_drain = async {
        while !registry.is_draining() {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        () = terminate => {}
        () = admin_drain => {}
    }
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs())
}

async fn run(config: RuntimeConfig) -> Result<(), BoxError> {
    let secrets = Arc::new(SecretResolver::new(&config.aws_region, config.openai_mode != ProviderMode::Simulator));
    let signing_key = secrets.resolve(&config.service_signing_key).await?;
    let signer = Arc::new(ServiceSigner::from_pkcs8_pem("voice-runtime", &config.service_key_id, signing_key.expose_secret().as_bytes())?);
    let webhook_secret = WebhookSecret::parse(secrets.resolve(&config.openai_webhook_secret).await?.expose_secret())?;
    let platform_api_key = secrets.resolve(&config.openai_platform_api_key).await?;
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()?;
    let (redis, admission_store) = connect_redis(&config).await?;
    let nats_options = match &config.nats_creds {
        Some(source) => async_nats::ConnectOptions::with_credentials(secrets.resolve(source).await?.expose_secret())?,
        None => async_nats::ConnectOptions::new(),
    };
    let nats = nats_options.name(format!("voice-runtime-{}", config.instance_id)).connect(config.nats_url.as_str()).await?;
    let jetstream = async_nats::jetstream::new(nats.clone());
    let jwks = fetch_jwks(&http, &config.service_jwks_url).await?;
    let (verifier_sender, verifier_receiver) = watch::channel(Arc::new(ServiceVerifier::from_jwks_json("voice-runtime", &jwks)?));

    let metrics = Arc::new(Metrics::new(velyric_voice_runtime::METRICS_PREFIX));
    let registry = Arc::new(Registry::default());
    let environment = config.environment.as_str();
    let state = Arc::new(RuntimeState {
        settings: RuntimeSettings {
            instance_id: config.instance_id.clone(),
            provider_mode: config.openai_mode,
            models: config.models.clone(),
            backend_max_output_tokens: config.backend_max_output_tokens,
            live_usd_micros_per_minute: config.live_usd_micros_per_minute,
        },
        control: Arc::new(ControlApiClient::new(http.clone(), config.control_api_url.clone(), Arc::clone(&signer), redis.clone(), environment)),
        openai: Arc::new(OpenAiLiveClient::new(http.clone(), config.openai_api_base.clone())?),
        gate: Arc::new(AdmissionGate::new(
            admission_store,
            config.environment,
            &config.aws_region,
            AdmissionLimits {
                global_max_calls: config.global_max_calls,
                provider_max_calls: config.provider_max_calls,
                fallback_max_calls_per_tenant: config.fallback_max_calls_per_tenant,
                lease: config.admission_lease,
            },
        )),
        registry: Arc::clone(&registry),
        metrics: Arc::clone(&metrics),
        secrets: Arc::clone(&secrets),
        jetstream: Some(jetstream),
        platform_webhook_secret: webhook_secret,
        platform_api_key,
        timing: SessionTiming::default(),
        seen_webhooks: DashMap::new(),
    });

    let shutdown = CancellationToken::new();
    let public_shutdown = CancellationToken::new();
    let commands_task = tokio::spawn(commands::serve(
        nats.clone(),
        Arc::new(CommandContext {
            registry: Arc::clone(&registry),
            verifier: verifier_receiver,
            replay: ReplayGuard::new(redis.clone(), environment),
            metrics: Arc::clone(&metrics),
        }),
        shutdown.clone(),
    ));
    let jwks_task = {
        let http = http.clone();
        let url = config.service_jwks_url.clone();
        let token = shutdown.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = token.cancelled() => break,
                    () = tokio::time::sleep(Duration::from_secs(600)) => {}
                }
                match fetch_jwks(&http, &url).await.and_then(|jwks| ServiceVerifier::from_jwks_json("voice-runtime", &jwks).map_err(BoxError::from)) {
                    Ok(verifier) => {
                        if verifier_sender.send(Arc::new(verifier)).is_err() {
                            break;
                        }
                    }
                    Err(error) => warn!(error = %error, "service JWKS refresh failed; keeping the previous key set"),
                }
            }
        })
    };
    let heartbeat_task = redis.clone().map(|manager| {
        let key = format!("vly:{environment}:runtime:instance:{}", config.instance_id);
        let registry = Arc::clone(&registry);
        let token = shutdown.clone();
        tokio::spawn(async move {
            loop {
                let mut connection = manager.clone();
                let fields = [
                    ("active_calls", registry.len().to_string()),
                    ("draining", registry.is_draining().to_string()),
                    ("updated_at", unix_now().to_string()),
                ];
                let written: redis::RedisResult<()> = redis::pipe().atomic().hset_multiple(&key, &fields).ignore().expire(&key, 30).ignore().query_async(&mut connection).await;
                if let Err(error) = written {
                    warn!(error = %error, "runtime instance heartbeat failed");
                }
                tokio::select! {
                    () = token.cancelled() => break,
                    () = tokio::time::sleep(Duration::from_secs(10)) => {}
                }
            }
            let mut connection = manager.clone();
            let removed: redis::RedisResult<()> = redis::cmd("DEL").arg(&key).query_async(&mut connection).await;
            if let Err(error) = removed {
                warn!(error = %error, "runtime instance record could not be removed");
            }
        })
    });

    let public_listener = TcpListener::bind(SocketAddr::new(config.host, config.public_port)).await?;
    let admin_listener = TcpListener::bind(SocketAddr::new(config.host, config.admin_port)).await?;
    info!(public = %public_listener.local_addr()?, admin = %admin_listener.local_addr()?, instance_id = %config.instance_id, "voice runtime listening");
    let public_server = {
        let token = public_shutdown.clone();
        tokio::spawn(async move { axum::serve(public_listener, public_router(state)).with_graceful_shutdown(async move { token.cancelled().await }).await })
    };
    let readiness_client = nats.clone();
    let admin_state = Arc::new(AdminState {
        registry: Arc::clone(&registry),
        metrics: Arc::clone(&metrics),
        readiness: Arc::new(move || readiness_client.connection_state() == async_nats::connection::State::Connected),
    });
    let admin_server = {
        let token = shutdown.clone();
        tokio::spawn(async move { axum::serve(admin_listener, admin_router(admin_state)).with_graceful_shutdown(async move { token.cancelled().await }).await })
    };

    wait_for_drain_trigger(&registry).await;
    registry.start_drain();
    info!(active_calls = registry.len(), timeout_seconds = config.drain_timeout.as_secs(), "drain started; no new calls are admitted");
    public_shutdown.cancel();
    if !registry.wait_until_idle(config.drain_timeout).await {
        warn!(remaining = registry.len(), "drain timeout reached; ending remaining calls");
        for sender in registry.senders() {
            if sender.send(SessionCommand::Shutdown { reason: ShutdownReason::DrainTimeout }).await.is_err() {
                warn!("session ended before the shutdown command was delivered");
            }
        }
        if !registry.wait_until_idle(Duration::from_secs(30)).await {
            error!(remaining = registry.len(), "calls still active after forced shutdown; reconciliation will close them");
        }
    }
    shutdown.cancel();
    for (name, result) in [("commands", commands_task.await.map(|result| result.map_err(|error| error.to_string())))] {
        if let Ok(Err(error)) = result {
            warn!(task = name, error = %error, "background task failed");
        }
    }
    let _ = jwks_task.await;
    if let Some(task) = heartbeat_task {
        let _ = task.await;
    }
    if let Err(error) = nats.drain().await {
        warn!(error = %error, "NATS drain failed");
    }
    for (name, server) in [("public", public_server), ("admin", admin_server)] {
        match server.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => warn!(server = name, error = %error, "HTTP server stopped with an error"),
            Err(error) => warn!(server = name, error = %error, "HTTP server task failed"),
        }
    }
    info!("voice runtime stopped");
    Ok(())
}
