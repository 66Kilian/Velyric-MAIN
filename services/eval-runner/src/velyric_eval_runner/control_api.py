from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import TYPE_CHECKING, ClassVar, Literal

import httpx
from pydantic import ConfigDict, TypeAdapter, ValidationError

if TYPE_CHECKING:
    from velyric_eval_runner.service_token import ServiceTokenSigner

SCOPE = "simulation.run"
_IGNORE = ConfigDict(extra="ignore")


@dataclass(frozen=True)
class SecretReference:
    __pydantic_config__: ClassVar[ConfigDict] = _IGNORE
    secret_ref: str
    secret_version: int


@dataclass(frozen=True)
class ToolFixture:
    __pydantic_config__: ClassVar[ConfigDict] = _IGNORE
    tool: str
    response: dict[str, object] | None = None
    error_code: str | None = None
    latency_ms: int | None = None


@dataclass(frozen=True)
class ScenarioDefinition:
    __pydantic_config__: ClassVar[ConfigDict] = _IGNORE
    caller_goal: str
    opening_line: str
    max_turns: int
    caller_facts: dict[str, str] = field(default_factory=dict)
    caller_persona: str | None = None
    tool_fixtures: tuple[ToolFixture, ...] = ()


@dataclass(frozen=True)
class Assertion:
    __pydantic_config__: ClassVar[ConfigDict] = _IGNORE
    type: str
    values: tuple[str, ...] = ()
    value: str | int | None = None
    tool: str | None = None
    phrase: str | None = None


@dataclass(frozen=True)
class Scenario:
    __pydantic_config__: ClassVar[ConfigDict] = _IGNORE
    id: str
    scenario_key: str
    scenario_class: str
    language: Literal["hu", "de", "en"]
    definition: ScenarioDefinition
    deterministic_assertions: tuple[Assertion, ...]
    seed: int


@dataclass(frozen=True)
class SuiteInfo:
    __pydantic_config__: ClassVar[ConfigDict] = _IGNORE
    id: str
    agent_id: str
    name: str
    min_pass_ratio: float
    is_release_gate: bool


@dataclass(frozen=True)
class RunInfo:
    __pydantic_config__: ClassVar[ConfigDict] = _IGNORE
    id: str
    suite_id: str
    agent_version_id: str
    status: str
    seed: int


@dataclass(frozen=True)
class AgentVersion:
    __pydantic_config__: ClassVar[ConfigDict] = _IGNORE
    id: str
    agent_id: str
    version_number: int
    config_hash: str
    config: dict[str, object]


@dataclass(frozen=True)
class ClaimContext:
    __pydantic_config__: ClassVar[ConfigDict] = _IGNORE
    run: RunInfo
    suite: SuiteInfo
    scenarios: tuple[Scenario, ...]
    agent_version: AgentVersion
    openai_api_key: SecretReference | None


@dataclass(frozen=True)
class ScenarioResult:
    scenario_id: str
    verdict: Literal["PASSED", "FAILED", "ERRORED"]
    score: float
    failed_assertions: tuple[str, ...]
    turns: int
    duration_ms: int
    tools_called: tuple[str, ...]
    outcome: str | None = None
    intent: str | None = None
    judge_notes: str | None = None
    error_code: str | None = None

    def as_json(self) -> dict[str, object]:
        body: dict[str, object] = {
            "scenario_id": self.scenario_id,
            "verdict": self.verdict,
            "score": round(min(1.0, max(0.0, self.score)), 4),
            "failed_assertions": [item[:300] for item in self.failed_assertions[:20]],
            "turns": min(self.turns, 60),
            "duration_ms": min(self.duration_ms, 3_600_000),
            "tools_called": list(self.tools_called[:50]),
        }
        optional = {
            "outcome": self.outcome,
            "intent": self.intent,
            "judge_notes": None if self.judge_notes is None else self.judge_notes[:1000],
            "error_code": self.error_code,
        }
        body.update({key: value for key, value in optional.items() if value is not None})
        return body


class ControlApiError(Exception):
    def __init__(
        self, message: str, *, status: int | None, code: str | None, retryable: bool
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable


_RETRYABLE_STATUSES = frozenset(
    {HTTPStatus.REQUEST_TIMEOUT, HTTPStatus.TOO_EARLY, HTTPStatus.TOO_MANY_REQUESTS}
)
_error_adapter: TypeAdapter[dict[str, object]] = TypeAdapter(dict[str, object])
_claim_adapter: TypeAdapter[ClaimContext] = TypeAdapter(ClaimContext)
_run_adapter: TypeAdapter[RunInfo] = TypeAdapter(RunInfo)


class ControlApiClient:
    def __init__(
        self, base_url: str, signer: ServiceTokenSigner, client: httpx.AsyncClient
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._signer = signer
        self._client = client

    async def _post(
        self, path: str, *, tenant_id: str, trace_id: str, body: dict[str, object]
    ) -> bytes:
        token = self._signer.sign(audience="control-api", scopes=(SCOPE,), tenant_id=tenant_id)
        headers = {
            "authorization": f"Bearer {token}",
            "traceparent": f"00-{trace_id}-{secrets.token_hex(8)}-01",
        }
        try:
            response = await self._client.post(
                f"{self._base_url}{path}", headers=headers, json=body, timeout=30.0
            )
        except httpx.HTTPError as error:
            msg = f"control-api request failed: {type(error).__name__}"
            raise ControlApiError(msg, status=None, code=None, retryable=True) from error
        if response.is_success:
            return response.content
        code: str | None = None
        try:
            raw_code = _error_adapter.validate_json(response.content).get("code")
            code = raw_code if isinstance(raw_code, str) else None
        except ValidationError:
            code = None
        message = f"control-api POST {path} returned {response.status_code} {code or ''}".strip()
        retryable = response.status_code in _RETRYABLE_STATUSES or response.is_server_error
        raise ControlApiError(message, status=response.status_code, code=code, retryable=retryable)

    async def claim(
        self, tenant_id: str, run_id: str, trace_id: str, model_versions: dict[str, str]
    ) -> ClaimContext:
        content = await self._post(
            f"/internal/v1/simulation-runs/{run_id}/claim",
            tenant_id=tenant_id,
            trace_id=trace_id,
            body={"model_versions": dict(model_versions)},
        )
        return _claim_adapter.validate_json(content)

    async def complete(
        self,
        tenant_id: str,
        run_id: str,
        trace_id: str,
        results: list[ScenarioResult],
    ) -> RunInfo:
        content = await self._post(
            f"/internal/v1/simulation-runs/{run_id}/complete",
            tenant_id=tenant_id,
            trace_id=trace_id,
            body={"results": [result.as_json() for result in results]},
        )
        return _run_adapter.validate_json(content)

    async def fail(self, tenant_id: str, run_id: str, trace_id: str, error_code: str) -> RunInfo:
        content = await self._post(
            f"/internal/v1/simulation-runs/{run_id}/error",
            tenant_id=tenant_id,
            trace_id=trace_id,
            body={"error_code": error_code},
        )
        return _run_adapter.validate_json(content)
