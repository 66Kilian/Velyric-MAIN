from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys

import boto3
import httpx
import nats
import structlog
from nats.aio.client import RawCredentials

from velyric_document_worker.config import ConfigError, WorkerConfig, load_config
from velyric_document_worker.consumer import KnowledgeJobConsumer, ensure_topology
from velyric_document_worker.control_api import ControlApiClient
from velyric_document_worker.embeddings import OpenAiEmbedder
from velyric_document_worker.fetcher import ObjectDownloader, RemoteFetcher, system_resolver
from velyric_document_worker.health import HealthServer
from velyric_document_worker.pipeline import IngestionPipeline
from velyric_document_worker.scanner import ClamdScanner
from velyric_document_worker.service_token import ServiceTokenSigner
from velyric_document_worker.tenant_secrets import TenantSecretReader

EXIT_CONFIG = 78


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO), stream=sys.stdout, format="%(message)s"
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        logger_factory=structlog.PrintLoggerFactory(),
    )


def _resolve_arn(region: str) -> object:
    client = boto3.client("secretsmanager", region_name=region)

    def resolve(arn: str) -> str:
        value = client.get_secret_value(SecretId=arn).get("SecretString")
        if not isinstance(value, str):
            msg = "SecretStringMissing"
            raise TypeError(msg)
        return value

    return resolve


async def run(config: WorkerConfig) -> None:
    log = structlog.get_logger("velyric.document_worker")
    secrets_client = (
        None
        if config.local_vault_dir is not None and not config.deployed
        else boto3.client("secretsmanager", region_name=config.aws_region)
    )
    async with (
        httpx.AsyncClient(http2=False, trust_env=False) as api_http,
        httpx.AsyncClient(http2=False, trust_env=False, verify=True) as fetch_http,
    ):
        control_api = ControlApiClient(
            config.control_api_url,
            ServiceTokenSigner(config.signing_key_pem, config.signing_key_id),
            api_http,
        )
        scanner = ClamdScanner(config.clamd_host, config.clamd_port)
        pipeline = IngestionPipeline(
            control_api=control_api,
            remote=RemoteFetcher(fetch_http, system_resolver, allow_http=config.allow_http_fetch),
            objects=ObjectDownloader(fetch_http),
            scanner=scanner,
            embedder=OpenAiEmbedder(config.openai_base_url),
            secrets=TenantSecretReader(secrets_client, config.local_vault_dir),
            ocr_enabled=config.ocr_enabled,
        )
        connect_options: dict[str, object] = {
            "servers": list(config.nats_url),
            "name": "document-worker",
            "max_reconnect_attempts": -1,
        }
        if config.nats_creds is not None:
            connect_options["user_credentials"] = RawCredentials(config.nats_creds)
        connection = await nats.connect(**connect_options)  # type: ignore[arg-type]
        js = connection.jetstream()
        await ensure_topology(js, config.stream_replicas)
        consumer = KnowledgeJobConsumer(js, pipeline, concurrency=config.concurrency)

        async def readiness() -> dict[str, bool]:
            return {
                "nats": connection.is_connected,
                "clamd": await scanner.ping(),
                "jetstream": consumer.last_fetch_ok,
            }

        def metrics() -> str:
            return (
                "# TYPE velyric_document_worker_jobs_processed_total counter\n"
                f"velyric_document_worker_jobs_processed_total {consumer.processed}\n"
                "# TYPE velyric_document_worker_jobs_retried_total counter\n"
                f"velyric_document_worker_jobs_retried_total {consumer.failed}\n"
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
        log.info("document worker started", port=config.port, concurrency=config.concurrency)
        try:
            await consumer.run()
        finally:
            await health.close()
            await connection.drain()
            log.info("document worker stopped")


def main() -> None:
    region = os.environ.get("VELYRIC_AWS_REGION", "eu-central-1")
    resolver = _resolve_arn(region)
    try:
        config = load_config(os.environ, resolver)  # type: ignore[arg-type]
    except ConfigError as error:
        sys.stderr.write(f"{error}\n")
        raise SystemExit(EXIT_CONFIG) from error
    _configure_logging(config.log_level)
    asyncio.run(run(config))


if __name__ == "__main__":
    main()
