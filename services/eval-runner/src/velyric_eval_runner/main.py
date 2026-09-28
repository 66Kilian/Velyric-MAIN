from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from typing import TYPE_CHECKING

import boto3
import httpx
import nats
import structlog
from nats.aio.client import RawCredentials

from velyric_eval_runner.config import ConfigError, RunnerConfig, load_config
from velyric_eval_runner.consumer import SimulationJobConsumer, ensure_topology
from velyric_eval_runner.control_api import ControlApiClient
from velyric_eval_runner.health import HealthServer
from velyric_eval_runner.models import LanguageModel, OpenAiLanguageModel
from velyric_eval_runner.runner import SimulationRunner
from velyric_eval_runner.service_token import ServiceTokenSigner
from velyric_eval_runner.tenant_secrets import TenantSecretReader

if TYPE_CHECKING:
    from collections.abc import Callable

EXIT_CONFIG = 78


def _configure_logging(level: str) -> None:
    numeric = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(level=numeric, stream=sys.stdout, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(numeric),
        logger_factory=structlog.PrintLoggerFactory(),
    )


def _arn_resolver(region: str) -> Callable[[str], str]:
    client = boto3.client("secretsmanager", region_name=region)

    def resolve(arn: str) -> str:
        value = client.get_secret_value(SecretId=arn).get("SecretString")
        if not isinstance(value, str):
            msg = "SecretStringMissing"
            raise TypeError(msg)
        return value

    return resolve


async def run(config: RunnerConfig) -> None:
    log = structlog.get_logger("velyric.eval_runner")
    secrets_client = (
        None
        if config.local_vault_dir is not None and not config.deployed
        else boto3.client("secretsmanager", region_name=config.aws_region)
    )
    base_model = OpenAiLanguageModel(config.openai_base_url)

    def model_factory(api_key: str) -> LanguageModel:
        return base_model.with_key(api_key)

    async with httpx.AsyncClient(http2=False, trust_env=False) as api_http:
        runner = SimulationRunner(
            control_api=ControlApiClient(
                config.control_api_url,
                ServiceTokenSigner(config.signing_key_pem, config.signing_key_id),
                api_http,
            ),
            secrets=TenantSecretReader(secrets_client, config.local_vault_dir),
            model_factory=model_factory,
            models=config.models,
            scenario_concurrency=config.scenario_concurrency,
        )
        connect_options: dict[str, object] = {
            "servers": list(config.nats_url),
            "name": "eval-runner",
            "max_reconnect_attempts": -1,
        }
        if config.nats_creds is not None:
            connect_options["user_credentials"] = RawCredentials(config.nats_creds)
        connection = await nats.connect(**connect_options)  # type: ignore[arg-type]
        js = connection.jetstream()
        await ensure_topology(js, config.stream_replicas)
        consumer = SimulationJobConsumer(js, runner, concurrency=config.run_concurrency)

        async def readiness() -> dict[str, bool]:
            return {"nats": connection.is_connected, "jetstream": consumer.last_fetch_ok}

        def metrics() -> str:
            return (
                "# TYPE velyric_eval_runner_runs_processed_total counter\n"
                f"velyric_eval_runner_runs_processed_total {consumer.processed}\n"
                "# TYPE velyric_eval_runner_runs_retried_total counter\n"
                f"velyric_eval_runner_runs_retried_total {consumer.failed}\n"
            )

        health = HealthServer(config.host, config.port, readiness, metrics)
        await health.start()
        loop = asyncio.get_running_loop()
        for signame in ("SIGTERM", "SIGINT"):
            if hasattr(signal, signame):
                try:
                    loop.add_signal_handler(getattr(signal, signame), consumer.stop)
                except NotImplementedError:
                    signal.signal(getattr(signal, signame), lambda _signum, _frame: consumer.stop())
        log.info("eval runner started", port=config.port, concurrency=config.run_concurrency)
        try:
            await consumer.run()
        finally:
            await health.close()
            await connection.drain()
            log.info("eval runner stopped")


def main() -> None:
    region = os.environ.get("VELYRIC_AWS_REGION", "eu-central-1")
    try:
        config = load_config(os.environ, _arn_resolver(region))
    except ConfigError as error:
        sys.stderr.write(f"{error}\n")
        raise SystemExit(EXIT_CONFIG) from error
    _configure_logging(config.log_level)
    asyncio.run(run(config))


if __name__ == "__main__":
    main()
