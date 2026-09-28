from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from http import HTTPStatus
from typing import TYPE_CHECKING, Literal, Protocol

import structlog

from velyric_eval_runner.control_api import ClaimContext, ControlApiError, Scenario, ScenarioResult
from velyric_eval_runner.conversation import ConversationSimulator
from velyric_eval_runner.judge import RubricJudge, failed_assertions
from velyric_eval_runner.models import ModelError
from velyric_eval_runner.tenant_secrets import SecretUnavailableError

if TYPE_CHECKING:
    from collections.abc import Callable

    from velyric_eval_runner.config import ModelSettings
    from velyric_eval_runner.control_api import RunInfo
    from velyric_eval_runner.models import LanguageModel

log = structlog.get_logger("velyric.eval_runner.runner")

_NOT_CLAIMABLE = frozenset({HTTPStatus.NOT_FOUND, HTTPStatus.CONFLICT})


@dataclass(frozen=True)
class SimulationJob:
    tenant_id: str
    run_id: str
    trace_id: str


@dataclass(frozen=True)
class JobResult:
    disposition: Literal["ACK", "RETRY"]
    outcome: str
    retry_after_seconds: float = 30.0


class RetryableScenarioError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class RunApi(Protocol):
    async def claim(
        self, tenant_id: str, run_id: str, trace_id: str, model_versions: dict[str, str]
    ) -> ClaimContext: ...

    async def complete(
        self, tenant_id: str, run_id: str, trace_id: str, results: list[ScenarioResult]
    ) -> RunInfo: ...

    async def fail(
        self, tenant_id: str, run_id: str, trace_id: str, error_code: str
    ) -> RunInfo: ...


class SecretReader(Protocol):
    def read(self, reference: str) -> str: ...


class SimulationRunner:
    def __init__(
        self,
        *,
        control_api: RunApi,
        secrets: SecretReader,
        model_factory: Callable[[str], LanguageModel],
        models: ModelSettings,
        scenario_concurrency: int,
    ) -> None:
        self._api = control_api
        self._secrets = secrets
        self._model_factory = model_factory
        self._models = models
        self._scenario_concurrency = scenario_concurrency

    async def run(self, job: SimulationJob, *, final_attempt: bool) -> JobResult:
        versions = {
            "agent": self._models.agent,
            "caller": self._models.caller,
            "judge": self._models.judge,
        }
        try:
            context = await self._api.claim(job.tenant_id, job.run_id, job.trace_id, versions)
        except ControlApiError as error:
            if error.status in _NOT_CLAIMABLE:
                return JobResult(disposition="ACK", outcome="NOT_CLAIMABLE")
            return JobResult(
                disposition="RETRY" if error.retryable else "ACK", outcome="CLAIM_FAILED"
            )
        if context.openai_api_key is None:
            return await self._fail(job, "openai_credentials_missing")
        try:
            api_key = self._secrets.read(context.openai_api_key.secret_ref)
        except SecretUnavailableError:
            if final_attempt:
                return await self._fail(job, "openai_credentials_unavailable")
            return JobResult(
                disposition="RETRY", outcome="SECRET_UNAVAILABLE", retry_after_seconds=60.0
            )
        model = self._model_factory(api_key)
        semaphore = asyncio.Semaphore(self._scenario_concurrency)

        async def bounded(scenario: Scenario) -> ScenarioResult:
            async with semaphore:
                return await self._scenario(context, scenario, model, final_attempt=final_attempt)

        try:
            results = await asyncio.gather(*(bounded(scenario) for scenario in context.scenarios))
        except RetryableScenarioError as error:
            log.warning("simulation run will be retried", run_id=job.run_id, code=error.code)
            return JobResult(disposition="RETRY", outcome=error.code, retry_after_seconds=60.0)
        try:
            run = await self._api.complete(job.tenant_id, job.run_id, job.trace_id, list(results))
        except ControlApiError as error:
            return JobResult(
                disposition="RETRY" if error.retryable else "ACK", outcome="COMPLETE_FAILED"
            )
        log.info("simulation run completed", run_id=job.run_id, status=run.status)
        return JobResult(disposition="ACK", outcome=run.status)

    async def _fail(self, job: SimulationJob, code: str) -> JobResult:
        try:
            await self._api.fail(job.tenant_id, job.run_id, job.trace_id, code)
        except ControlApiError as error:
            if error.retryable:
                return JobResult(disposition="RETRY", outcome="FAIL_REPORT_PENDING")
        return JobResult(disposition="ACK", outcome=code.upper())

    async def _scenario(
        self,
        context: ClaimContext,
        scenario: Scenario,
        model: LanguageModel,
        *,
        final_attempt: bool,
    ) -> ScenarioResult:
        started = time.monotonic()
        simulator = ConversationSimulator(
            model, agent_model=self._models.agent, caller_model=self._models.caller
        )
        judge = RubricJudge(model, judge_model=self._models.judge)
        try:
            record = await simulator.run(scenario, context.agent_version.config)
            failures = failed_assertions(scenario, record)
            rubric = await judge.score(scenario, record)
        except ModelError as error:
            if error.retryable and not final_attempt:
                raise RetryableScenarioError(error.code) from error
            return ScenarioResult(
                scenario_id=scenario.id,
                verdict="ERRORED",
                score=0.0,
                failed_assertions=(),
                turns=0,
                duration_ms=int((time.monotonic() - started) * 1000),
                tools_called=(),
                error_code=error.code,
            )
        passed = not failures and rubric.score >= self._models.pass_score
        if rubric.score < self._models.pass_score:
            failures.append(f"RUBRIC score {rubric.score:.2f} below {self._models.pass_score:.2f}")
        return ScenarioResult(
            scenario_id=scenario.id,
            verdict="PASSED" if passed else "FAILED",
            score=rubric.score,
            failed_assertions=tuple(failures),
            turns=len(record.turns),
            duration_ms=int((time.monotonic() - started) * 1000),
            tools_called=tuple(record.tools_called),
            outcome=record.outcome,
            intent=record.intent,
            judge_notes=rubric.notes or None,
        )
