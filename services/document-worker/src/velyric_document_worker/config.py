from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit

from velyric_document_worker.generated.enums import ProviderMode, VelyricEnvironment

SecretResolver = Callable[[str], str]

_ALLOWED_MODES: Mapping[VelyricEnvironment, tuple[ProviderMode, ...]] = {
    VelyricEnvironment.LOCAL: (ProviderMode.SIMULATOR, ProviderMode.SANDBOX),
    VelyricEnvironment.CI: (ProviderMode.SIMULATOR,),
    VelyricEnvironment.STAGING: (ProviderMode.SANDBOX,),
    VelyricEnvironment.PRODUCTION: (ProviderMode.LIVE,),
}
_DEFAULT_MODE: Mapping[VelyricEnvironment, ProviderMode] = {
    VelyricEnvironment.LOCAL: ProviderMode.SIMULATOR,
    VelyricEnvironment.CI: ProviderMode.SIMULATOR,
    VelyricEnvironment.STAGING: ProviderMode.SANDBOX,
    VelyricEnvironment.PRODUCTION: ProviderMode.LIVE,
}
_ARN = re.compile(r"^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$")
_KEY_ID = re.compile(r"^[A-Za-z0-9_.-]{4,128}$")
_REGION = re.compile(r"^[a-z]{2}-[a-z]+-\d$")


class ConfigError(Exception):
    def __init__(self, issues: list[str]) -> None:
        super().__init__("invalid document-worker configuration: " + "; ".join(issues))
        self.issues = tuple(issues)


@dataclass(frozen=True)
class WorkerConfig:
    environment: VelyricEnvironment
    aws_region: str
    log_level: str
    host: str
    port: int
    nats_url: tuple[str, ...]
    nats_creds: str | None
    control_api_url: str
    signing_key_pem: str
    signing_key_id: str
    openai_mode: ProviderMode
    openai_base_url: str | None
    clamd_host: str
    clamd_port: int
    concurrency: int
    allow_http_fetch: bool
    local_vault_dir: str | None
    ocr_enabled: bool
    stream_replicas: int

    @property
    def deployed(self) -> bool:
        return self.environment in (VelyricEnvironment.STAGING, VelyricEnvironment.PRODUCTION)


class _Reader:
    def __init__(self, env: Mapping[str, str]) -> None:
        self._env = env
        self.issues: list[str] = []

    def optional(self, name: str) -> str | None:
        value = self._env.get(name, "").strip()
        return value or None

    def required(self, name: str) -> str:
        value = self.optional(name)
        if value is None:
            self.issues.append(f"{name} is required")
            return ""
        return value

    def integer(self, name: str, default: int, minimum: int, maximum: int) -> int:
        raw = self.optional(name)
        if raw is None:
            return default
        if not raw.isdigit() or not minimum <= int(raw) <= maximum:
            self.issues.append(f"{name} must be an integer between {minimum} and {maximum}")
            return default
        return int(raw)

    def flag(self, name: str, *, default: bool) -> bool:
        raw = self.optional(name)
        if raw is None:
            return default
        if raw not in ("true", "false"):
            self.issues.append(f"{name} must be true or false")
            return default
        return raw == "true"


def _secret(
    reader: _Reader,
    name: str,
    environment: VelyricEnvironment,
    resolver: SecretResolver,
    *,
    required: bool,
) -> str | None:
    plain = reader.optional(f"{name}_SECRET")
    arn = reader.optional(f"{name}_SECRET_ARN")
    deployed = environment in (VelyricEnvironment.STAGING, VelyricEnvironment.PRODUCTION)
    if plain is not None and arn is not None:
        reader.issues.append(f"only one of {name}_SECRET and {name}_SECRET_ARN may be set")
        return None
    if plain is not None:
        if deployed:
            reader.issues.append(
                f"{name}_SECRET is not allowed in {environment}; use {name}_SECRET_ARN"
            )
            return None
        return plain
    if arn is not None:
        if _ARN.match(arn) is None:
            reader.issues.append(f"{name}_SECRET_ARN must be a Secrets Manager ARN")
            return None
        try:
            return resolver(arn)
        except Exception as error:  # noqa: BLE001
            reader.issues.append(f"{name}_SECRET_ARN could not be resolved: {type(error).__name__}")
            return None
    if required:
        suffix = "_SECRET_ARN" if deployed else "_SECRET or " + name + "_SECRET_ARN"
        reader.issues.append(f"{name}{suffix} is required")
    return None


def load_config(env: Mapping[str, str], resolver: SecretResolver) -> WorkerConfig:
    reader = _Reader(env)
    raw_environment = reader.required("VELYRIC_ENV")
    try:
        environment = VelyricEnvironment(raw_environment)
    except ValueError:
        if raw_environment:
            reader.issues.append("VELYRIC_ENV must be one of local, ci, staging, production")
        environment = VelyricEnvironment.PRODUCTION
    deployed = environment in (VelyricEnvironment.STAGING, VelyricEnvironment.PRODUCTION)

    region = reader.optional("VELYRIC_AWS_REGION") or "eu-central-1"
    if _REGION.match(region) is None:
        reader.issues.append("VELYRIC_AWS_REGION must be an AWS region such as eu-central-1")

    nats_raw = reader.required("VELYRIC_NATS_URL")
    nats_urls = tuple(part.strip() for part in nats_raw.split(",") if part.strip())
    for url in nats_urls:
        if not (url.startswith("tls://") or (not deployed and url.startswith("nats://"))):
            reader.issues.append(
                "VELYRIC_NATS_URL must use tls:// (nats:// is allowed only in local and ci)"
            )
            break

    control_api_url = reader.required("VELYRIC_CONTROL_API_INTERNAL_URL").rstrip("/")
    parsed = urlsplit(control_api_url)
    if control_api_url and (parsed.scheme not in ("http", "https") or not parsed.netloc):
        reader.issues.append("VELYRIC_CONTROL_API_INTERNAL_URL must be an http(s) URL")
    if control_api_url and deployed and parsed.scheme != "https":
        reader.issues.append("VELYRIC_CONTROL_API_INTERNAL_URL must use https outside local and ci")

    raw_mode = reader.optional("VELYRIC_PROVIDER_MODE_OPENAI") or _DEFAULT_MODE[environment]
    try:
        openai_mode = ProviderMode(raw_mode)
    except ValueError:
        reader.issues.append("VELYRIC_PROVIDER_MODE_OPENAI must be simulator, sandbox or live")
        openai_mode = _DEFAULT_MODE[environment]
    if openai_mode not in _ALLOWED_MODES[environment]:
        reader.issues.append(
            f"VELYRIC_PROVIDER_MODE_OPENAI={openai_mode} is not allowed in {environment}"
        )
    openai_base_url: str | None = None
    if openai_mode == ProviderMode.SIMULATOR:
        simulator = reader.required("VELYRIC_PROVIDER_SIMULATOR_URL").rstrip("/")
        openai_base_url = f"{simulator}/openai/v1" if simulator else None

    key_id = reader.required("DOCUMENT_WORKER_SERVICE_KEY_ID")
    if key_id and _KEY_ID.match(key_id) is None:
        reader.issues.append("DOCUMENT_WORKER_SERVICE_KEY_ID has an invalid format")

    allow_http = reader.flag("DOCUMENT_WORKER_ALLOW_HTTP_FETCH", default=False)
    if allow_http and deployed:
        reader.issues.append("DOCUMENT_WORKER_ALLOW_HTTP_FETCH is only allowed in local and ci")
    local_vault_dir = reader.optional("DOCUMENT_WORKER_LOCAL_VAULT_DIR")
    if local_vault_dir is not None and deployed:
        reader.issues.append("DOCUMENT_WORKER_LOCAL_VAULT_DIR is only allowed in local and ci")

    signing_key = (
        _secret(reader, "VELYRIC_SERVICE_SIGNING_KEY", environment, resolver, required=True) or ""
    )
    if signing_key and "BEGIN PRIVATE KEY" not in signing_key:
        reader.issues.append("VELYRIC_SERVICE_SIGNING_KEY must be a PKCS#8 PEM private key")
    nats_creds = _secret(reader, "VELYRIC_NATS_CREDS", environment, resolver, required=deployed)

    config = WorkerConfig(
        environment=environment,
        aws_region=region,
        log_level=reader.optional("VELYRIC_LOG_LEVEL") or "info",
        host=reader.optional("DOCUMENT_WORKER_HOST") or ("0.0.0.0" if deployed else "127.0.0.1"),  # noqa: S104
        port=reader.integer("DOCUMENT_WORKER_PORT", 7400, 1, 65535),
        nats_url=nats_urls,
        nats_creds=nats_creds,
        control_api_url=control_api_url,
        signing_key_pem=signing_key,
        signing_key_id=key_id,
        openai_mode=openai_mode,
        openai_base_url=openai_base_url,
        clamd_host=reader.required("DOCUMENT_WORKER_CLAMD_HOST"),
        clamd_port=reader.integer("DOCUMENT_WORKER_CLAMD_PORT", 3310, 1, 65535),
        concurrency=reader.integer("DOCUMENT_WORKER_CONCURRENCY", 4, 1, 32),
        allow_http_fetch=allow_http,
        local_vault_dir=local_vault_dir,
        ocr_enabled=reader.flag("DOCUMENT_WORKER_OCR_ENABLED", default=True),
        stream_replicas=reader.integer(
            "DOCUMENT_WORKER_STREAM_REPLICAS", 3 if deployed else 1, 1, 5
        ),
    )
    if reader.issues:
        raise ConfigError(reader.issues)
    return config
