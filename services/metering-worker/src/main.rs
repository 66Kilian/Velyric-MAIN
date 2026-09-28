#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use secrecy::ExposeSecret;
use time::OffsetDateTime;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use velyric_common_observability::TelemetryConfig;
use velyric_metering_worker::config::{self, WorkerConfig};
use velyric_metering_worker::consumer::{self, BoxError, CALL_EVENTS_CONSUMER, USAGE_CONSUMER};
use velyric_metering_worker::handlers::{self, Disposition};
use velyric_metering_worker::metrics::Metrics;
use velyric_metering_worker::pricing::PriceTable;
use velyric_metering_worker::server::{HealthState, router};
use velyric_metering_worker::store::Store;
use velyric_service_kit::secrets::SecretResolver;

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
        service_name: "metering-worker",
        service_version: env!("CARGO_PKG_VERSION"),
        environment: config.environment.as_str().to_owned(),
        log_level: config.log_level.clone(),
        json: config.environment.is_deployed(),
    };
    if let Err(error) = velyric_common_observability::init(&telemetry) {
        eprintln!("{error}");
        return ExitCode::from(78);
    }
    velyric_metering_worker::install_crypto_provider();
    match run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            error!(error = %error, "metering worker stopped");
            ExitCode::FAILURE
        }
    }
}

async fn shutdown_signal() {
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
    }
}

async fn release_daily_caps(store: &Store, prices: &PriceTable, metrics: &Metrics) {
    let tenants = match store.tenants().await {
        Ok(tenants) => tenants,
        Err(error) => {
            warn!(error = %error, "tenant list unavailable for daily cap release");
            return;
        }
    };
    for tenant_id in tenants {
        match store.release_daily_cap(tenant_id, OffsetDateTime::now_utc(), prices).await {
            Ok(true) => {
                info!(%tenant_id, "daily spend cap released for the new day");
                metrics.increment("daily_caps_released", "scope", "tenant");
            }
            Ok(false) => {}
            Err(error) => warn!(error = %error, %tenant_id, "daily spend cap release failed"),
        }
    }
}

async fn run(config: WorkerConfig) -> Result<(), BoxError> {
    let secrets = SecretResolver::new(&config.aws_region, false);
    let database_url = secrets.resolve(&config.database_url).await?;
    let store = Arc::new(Store::connect(database_url.expose_secret(), config.database_role.as_deref(), config.database_max_connections).await?);
    let nats_options = match &config.nats_creds {
        Some(source) => async_nats::ConnectOptions::with_credentials(secrets.resolve(source).await?.expose_secret())?,
        None => async_nats::ConnectOptions::new(),
    };
    let nats = nats_options.name(format!("metering-worker-{}", config.instance_id)).connect(config.nats_url.as_str()).await?;
    let jetstream = async_nats::jetstream::new(nats.clone());
    consumer::ensure_streams(&jetstream, config.stream_replicas).await?;

    let metrics = Arc::new(Metrics::new(velyric_metering_worker::METRICS_PREFIX));
    let prices = Arc::new(config.token_prices.clone());
    let shutdown = CancellationToken::new();
    let max_deliver = config.max_deliver;

    let mut usage_task = {
        let (store, prices, metrics, context, token) = (Arc::clone(&store), Arc::clone(&prices), Arc::clone(&metrics), jetstream.clone(), shutdown.clone());
        tokio::spawn(async move {
            consumer::run(context, USAGE_CONSUMER, max_deliver, Arc::clone(&metrics), token, |subject, payload, delivered| {
                let (store, prices, metrics) = (Arc::clone(&store), Arc::clone(&prices), Arc::clone(&metrics));
                async move {
                    match handlers::parse_usage(&subject, &payload, OffsetDateTime::now_utc()) {
                        Ok((usage, occurred_at)) => handlers::record(&store, &prices, &metrics, &usage, occurred_at, delivered, max_deliver).await,
                        Err(reason) => Disposition::DeadLetter { reason },
                    }
                }
            })
            .await
        })
    };
    let mut call_events_task = {
        let (store, prices, metrics, context, token) = (Arc::clone(&store), Arc::clone(&prices), Arc::clone(&metrics), jetstream.clone(), shutdown.clone());
        tokio::spawn(async move {
            consumer::run(context, CALL_EVENTS_CONSUMER, max_deliver, Arc::clone(&metrics), token, |subject, payload, delivered| {
                let (store, prices, metrics) = (Arc::clone(&store), Arc::clone(&prices), Arc::clone(&metrics));
                async move {
                    match handlers::parse_call_ended(&subject, &payload, OffsetDateTime::now_utc()) {
                        Ok(Some((usage, occurred_at))) => handlers::record(&store, &prices, &metrics, &usage, occurred_at, delivered, max_deliver).await,
                        Ok(None) => Disposition::Ack,
                        Err(reason) => Disposition::DeadLetter { reason },
                    }
                }
            })
            .await
        })
    };
    let cap_task = {
        let (store, prices, metrics, token) = (Arc::clone(&store), Arc::clone(&prices), Arc::clone(&metrics), shutdown.clone());
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(300));
            loop {
                tokio::select! {
                    () = token.cancelled() => break,
                    _ = ticker.tick() => release_daily_caps(&store, &prices, &metrics).await,
                }
            }
        })
    };

    let readiness_store = Arc::clone(&store);
    let readiness_nats = nats.clone();
    let health = Arc::new(HealthState {
        metrics: Arc::clone(&metrics),
        readiness: Arc::new(move || {
            let store = Arc::clone(&readiness_store);
            let connected = readiness_nats.connection_state() == async_nats::connection::State::Connected;
            async move { connected && store.ping().await }.boxed()
        }),
    });
    let listener = TcpListener::bind(SocketAddr::new(config.host, config.port)).await?;
    info!(address = %listener.local_addr()?, instance_id = %config.instance_id, "metering worker running");
    let server = {
        let token = shutdown.clone();
        tokio::spawn(async move { axum::serve(listener, router(health)).with_graceful_shutdown(async move { token.cancelled().await }).await })
    };

    let mut failure: Option<BoxError> = None;
    tokio::select! {
        () = shutdown_signal() => info!("shutdown requested"),
        result = &mut usage_task => failure = Some(format!("usage consumer stopped: {result:?}").into()),
        result = &mut call_events_task => failure = Some(format!("call event consumer stopped: {result:?}").into()),
    }
    shutdown.cancel();
    for (name, task) in [("usage", usage_task), ("call_events", call_events_task)] {
        if task.is_finished() && failure.is_some() {
            continue;
        }
        match task.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => error!(consumer = name, error = %error, "consumer failed"),
            Err(error) => error!(consumer = name, error = %error, "consumer task panicked"),
        }
    }
    let _ = cap_task.await;
    if let Err(error) = nats.drain().await {
        warn!(error = %error, "NATS drain failed");
    }
    match server.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn!(error = %error, "health server stopped with an error"),
        Err(error) => warn!(error = %error, "health server task failed"),
    }
    failure.map_or(Ok(()), Err)
}
