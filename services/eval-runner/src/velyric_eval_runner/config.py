from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit

from velyric_eval_runner.generated.enums import ProviderMode, VelyricEnvironment

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
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$")


class ConfigError(Exception):
    def __init__(self, issues: list[str]) -> None:
        super().__init__("invalid eval-runner configuration: " + "; ".join(issues))
        self.issues = tuple(issues)


@dataclass(frozen=True)
class ModelSettings:
    agent: str
    caller: str
    judge: str
    pass_score: float


@dataclass(frozen=True)
class RunnerConfig:
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
    models: ModelSettings
    run_concurrency: int
    scenario_concurrency: int
    local_vault_dir: str | None
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

    def model(self, name: str, default: str) -> str:
        value = self.optional(name) or default
        if _MODEL.match(value) is None:
            self.issues.append(f"{name} must be a model identifier")
        return value


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


def _environment(reader: _Reader) -> VelyricEnvironment:
    raw = reader.required("VELYRIC_ENV")
    try:
        return VelyricEnvironment(raw)
    except ValueError:
        if raw:
            reader.issues.append("VELYRIC_ENV must be one of local, ci, staging, production")
        return VelyricEnvironment.PRODUCTION


def _openai(reader: _Reader, environment: VelyricEnvironment) -> tuple[ProviderMode, str | None]:
    raw_mode = reader.optional("VELYRIC_PROVIDER_MODE_OPENAI") or _DEFAULT_MODE[environment]
    try:
        mode = ProviderMode(raw_mode)
    except ValueError:
        reader.issues.append("VELYRIC_PROVIDER_MODE_OPENAI must be simulator, sandbox or live")
        mode = _DEFAULT_MODE[environment]
    if mode not in _ALLOWED_MODES[environment]:
        reader.issues.append(f"VELYRIC_PROVIDER_MODE_OPENAI={mode} is not allowed in {environment}")
    if mode != ProviderMode.SIMULATOR:
        return mode, None
    simulator = reader.required("VELYRIC_PROVIDER_SIMULATOR_URL").rstrip("/")
    return mode, (f"{simulator}/openai/v1" if simulator else None)


def load_config(env: Mapping[str, str], resolver: SecretResolver) -> RunnerConfig:
    reader = _Reader(env)
    environment = _environment(reader)
    deployed = environment in (VelyricEnvironment.STAGING, VelyricEnvironment.PRODUCTION)

    region = reader.optional("VELYRIC_AWS_REGION") or "eu-central-1"
    if _REGION.match(region) is None:
        reader.issues.append("VELYRIC_AWS_REGION must be an AWS region such as eu-central-1")

    nats_urls = tuple(
        part.strip() for part in reader.required("VELYRIC_NATS_URL").split(",") if part.strip()
    )
    if any(
        not (url.startswith("tls://") or (not deployed and url.startswith("nats://")))
        for url in nats_urls
    ):
        reader.issues.append(
            "VELYRIC_NATS_URL must use tls:// (nats:// is allowed only in local and ci)"
        )

    control_api_url = reader.required("VELYRIC_CONTROL_API_INTERNAL_URL").rstrip("/")
    parsed = urlsplit(control_api_url)
    if control_api_url and (parsed.scheme not in ("http", "https") or not parsed.netloc):
        reader.issues.append("VELYRIC_CONTROL_API_INTERNAL_URL must be an http(s) URL")
    if control_api_url and deployed and parsed.scheme != "https":
        reader.issues.append("VELYRIC_CONTROL_API_INTERNAL_URL must use https outside local and ci")

    openai_mode, openai_base_url = _openai(reader, environment)

    key_id = reader.required("EVAL_RUNNER_SERVICE_KEY_ID")
    if key_id and _KEY_ID.match(key_id) is None:
        reader.issues.append("EVAL_RUNNER_SERVICE_KEY_ID has an invalid format")
    local_vault_dir = reader.optional("EVAL_RUNNER_LOCAL_VAULT_DIR")
    if local_vault_dir is not None and deployed:
        reader.issues.append("EVAL_RUNNER_LOCAL_VAULT_DIR is only allowed in local and ci")

    signing_key = (
        _secret(reader, "VELYRIC_SERVICE_SIGNING_KEY", environment, resolver, required=True) or ""
    )
    if signing_key and "BEGIN PRIVATE KEY" not in signing_key:
        reader.issues.append("VELYRIC_SERVICE_SIGNING_KEY must be a PKCS#8 PEM private key")
    nats_creds = _secret(reader, "VELYRIC_NATS_CREDS", environment, resolver, required=deployed)

    models = ModelSettings(
        agent=reader.model("EVAL_RUNNER_AGENT_MODEL", "gpt-4.1-mini"),
        caller=reader.model("EVAL_RUNNER_CALLER_MODEL", "gpt-4.1-mini"),
        judge=reader.model("EVAL_RUNNER_JUDGE_MODEL", "gpt-4.1"),
        pass_score=reader.integer("EVAL_RUNNER_PASS_SCORE_PERCENT", 70, 1, 100) / 100,
    )
    config = RunnerConfig(
        environment=environment,
        aws_region=region,
        log_level=reader.optional("VELYRIC_LOG_LEVEL") or "info",
        host=reader.optional("EVAL_RUNNER_HOST") or ("0.0.0.0" if deployed else "127.0.0.1"),  # noqa: S104
        port=reader.integer("EVAL_RUNNER_PORT", 7500, 1, 65535),
        nats_url=nats_urls,
        nats_creds=nats_creds,
        control_api_url=control_api_url,
        signing_key_pem=signing_key,
        signing_key_id=key_id,
        openai_mode=openai_mode,
        openai_base_url=openai_base_url,
        models=models,
        run_concurrency=reader.integer("EVAL_RUNNER_RUN_CONCURRENCY", 2, 1, 16),
        scenario_concurrency=reader.integer("EVAL_RUNNER_SCENARIO_CONCURRENCY", 3, 1, 16),
        local_vault_dir=local_vault_dir,
        stream_replicas=reader.integer("EVAL_RUNNER_STREAM_REPLICAS", 3 if deployed else 1, 1, 5),
    )
    if reader.issues:
        raise ConfigError(reader.issues)
    return config
