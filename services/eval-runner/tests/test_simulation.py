from __future__ import annotations

import json
import uuid
from typing import TYPE_CHECKING

import pytest

from velyric_eval_runner.config import ConfigError, ModelSettings, load_config
from velyric_eval_runner.consumer import decode_job
from velyric_eval_runner.control_api import (
    AgentVersion,
    Assertion,
    ClaimContext,
    RunInfo,
    Scenario,
    ScenarioDefinition,
    ScenarioResult,
    SecretReference,
    SuiteInfo,
    ToolFixture,
)
from velyric_eval_runner.conversation import (
    ConversationRecord,
    ConversationSimulator,
    Turn,
    allowed_tools,
    fixture_result,
    opening_for,
)
from velyric_eval_runner.judge import assertion_failure, failed_assertions, parse_rubric
from velyric_eval_runner.models import ChatMessage, ModelError, ModelReply, ToolCall, ToolSpec
from velyric_eval_runner.runner import SimulationJob, SimulationRunner
from velyric_eval_runner.tenant_secrets import SecretUnavailableError

if TYPE_CHECKING:
    from collections.abc import Callable

TENANT = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b"
RUN = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6c"
SCENARIO = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6d"
MODELS = ModelSettings(
    agent="agent-model", caller="caller-model", judge="judge-model", pass_score=0.7
)

CONFIG: dict[str, object] = {
    "languages": [{"locale": "hu", "greeting": "Jó napot, miben segíthetek?"}],
    "disclosure": {"texts": {"hu": "Mesterséges intelligenciával beszél."}},
    "specialists": [
        {"kind": "RECEPTION_ROUTER", "enabled": True, "tool_allowlist": ["list_services"]},
        {
            "kind": "BOOKING",
            "enabled": True,
            "tool_allowlist": ["check_availability", "list_services"],
        },
        {"kind": "SALES", "enabled": False, "tool_allowlist": ["create_lead"]},
    ],
    "handoff": {"destinations": [{"label": "reception", "description": "Recepció"}]},
    "business_hours": [{"iso_weekday": 1, "opens": "08:00", "closes": "17:00"}],
    "timezone": "Europe/Budapest",
    "persona": {"warmth": 70},
}


def scenario(assertions: tuple[Assertion, ...] = (), max_turns: int = 4) -> Scenario:
    return Scenario(
        id=SCENARIO,
        scenario_key="booking.happy",
        scenario_class="HAPPY_PATH",
        language="hu",
        definition=ScenarioDefinition(
            caller_goal="Időpont foglalása",
            opening_line="Szeretnék időpontot foglalni.",
            max_turns=max_turns,
            caller_facts={"name": "Kiss Anna"},
            tool_fixtures=(
                ToolFixture(tool="check_availability", response={"slots": ["10:00"]}),
                ToolFixture(tool="check_availability", error_code="UPSTREAM_TIMEOUT"),
            ),
        ),
        deterministic_assertions=assertions,
        seed=42,
    )


class ScriptedModel:
    def __init__(self, replies: dict[str, list[ModelReply]]) -> None:
        self._replies = replies
        self.calls: list[tuple[str, list[ChatMessage], list[ToolSpec]]] = []

    async def complete(
        self,
        model: str,
        messages: list[ChatMessage],
        *,
        tools: list[ToolSpec],
        seed: int,
        json_output: bool = False,
    ) -> ModelReply:
        assert seed >= 0
        assert json_output == (model == "judge-model")
        self.calls.append((model, list(messages), list(tools)))
        queue = self._replies[model]
        if not queue:
            raise ModelError("model_unavailable", retryable=True)
        return queue.pop(0)


def happy_model(score: float = 0.9) -> ScriptedModel:
    return ScriptedModel(
        {
            "agent-model": [
                ModelReply(
                    text="",
                    tool_calls=(ToolCall("c1", "check_availability", '{"date":"2026-09-22"}'),),
                ),
                ModelReply(text="Kedden 10:00 szabad. Lefoglaljam?", tool_calls=()),
                ModelReply(
                    text="",
                    tool_calls=(
                        ToolCall(
                            "c2", "end_call", '{"outcome":"BOOKING_CREATED","intent":"BOOKING"}'
                        ),
                    ),
                ),
            ],
            "caller-model": [ModelReply(text="Igen, kérem.", tool_calls=())],
            "judge-model": [
                ModelReply(text=json.dumps({"score": score, "notes": "ok"}), tool_calls=())
            ],
        }
    )


class FakeApi:
    def __init__(self, context: ClaimContext) -> None:
        self.context = context
        self.completed: list[list[ScenarioResult]] = []
        self.failed: list[str] = []

    async def claim(
        self, tenant_id: str, run_id: str, trace_id: str, model_versions: dict[str, str]
    ) -> ClaimContext:
        assert (tenant_id, run_id, len(trace_id)) == (TENANT, RUN, 32)
        assert model_versions == {
            "agent": "agent-model",
            "caller": "caller-model",
            "judge": "judge-model",
        }
        return self.context

    async def complete(
        self, tenant_id: str, run_id: str, trace_id: str, results: list[ScenarioResult]
    ) -> RunInfo:
        assert (tenant_id, len(trace_id)) == (TENANT, 32)
        self.completed.append(results)
        passed = all(result.verdict == "PASSED" for result in results)
        return RunInfo(
            id=run_id,
            suite_id="s",
            agent_version_id="v",
            status="PASSED" if passed else "FAILED",
            seed=1,
        )

    async def fail(self, tenant_id: str, run_id: str, trace_id: str, error_code: str) -> RunInfo:
        assert (tenant_id, len(trace_id)) == (TENANT, 32)
        self.failed.append(error_code)
        return RunInfo(id=run_id, suite_id="s", agent_version_id="v", status="ERRORED", seed=1)


class FakeSecrets:
    def __init__(self, *, available: bool = True) -> None:
        self.available = available

    def read(self, reference: str) -> str:
        if not self.available:
            raise SecretUnavailableError(reference)
        return "sk-tenant"


VAULT_REFERENCE = "local-vault://tenant/openai"


def factory(build: Callable[[], ScriptedModel]) -> Callable[[str], ScriptedModel]:
    def create(api_key: str) -> ScriptedModel:
        assert api_key == "sk-tenant"
        return build()

    return create


def claim_context(scenarios: tuple[Scenario, ...], *, with_key: bool = True) -> ClaimContext:
    reference = SecretReference(secret_ref=VAULT_REFERENCE, secret_version=1)
    return ClaimContext(
        run=RunInfo(id=RUN, suite_id="suite", agent_version_id="version", status="RUNNING", seed=7),
        suite=SuiteInfo(
            id="suite", agent_id="agent", name="Gate", min_pass_ratio=1.0, is_release_gate=True
        ),
        scenarios=scenarios,
        agent_version=AgentVersion(
            id="version", agent_id="agent", version_number=3, config_hash="h", config=CONFIG
        ),
        openai_api_key=reference if with_key else None,
    )


JOB = SimulationJob(tenant_id=TENANT, run_id=RUN, trace_id="a" * 32)


def test_config_helpers_read_enabled_tools_and_opening() -> None:
    assert allowed_tools(CONFIG) == ["list_services", "check_availability"]
    assert (
        opening_for(CONFIG, "hu")
        == "Mesterséges intelligenciával beszél. Jó napot, miben segíthetek?"
    )
    used: dict[str, int] = {}
    fixtures = scenario().definition.tool_fixtures
    assert json.loads(fixture_result(fixtures, "check_availability", used)) == {"slots": ["10:00"]}
    assert json.loads(fixture_result(fixtures, "check_availability", used)) == {
        "error": "UPSTREAM_TIMEOUT"
    }
    assert json.loads(fixture_result(fixtures, "check_availability", used)) == {
        "error": "UPSTREAM_TIMEOUT"
    }
    assert json.loads(fixture_result(fixtures, "create_booking", used)) == {
        "error": "TOOL_UNAVAILABLE"
    }


def test_assertions_cover_every_supported_type() -> None:
    record = ConversationRecord(
        turns=[
            Turn("agent", "Kedden 10:00 szabad"),
            Turn("caller", "Igen"),
            Turn("agent", "Lefoglaltam"),
        ],
        tools_called=["check_availability"],
        transferred=False,
        outcome="BOOKING_CREATED",
        intent="BOOKING",
    )
    passing = (
        Assertion(type="OUTCOME_IN", values=("BOOKING_CREATED", "RESOLVED")),
        Assertion(type="INTENT_IS", value="BOOKING"),
        Assertion(type="TOOL_CALLED", tool="check_availability"),
        Assertion(type="TOOL_NOT_CALLED", tool="cancel_booking"),
        Assertion(type="NOT_TRANSFERRED"),
        Assertion(type="PHRASE_PRESENT", phrase="lefoglaltam"),
        Assertion(type="PHRASE_ABSENT", phrase="ingyenes"),
        Assertion(type="MAX_AGENT_TURNS", value=2),
    )
    assert failed_assertions(scenario(passing), record) == []
    assert assertion_failure(Assertion(type="TRANSFERRED"), record) == "TRANSFERRED"
    assert (
        assertion_failure(Assertion(type="TOOL_CALLED", tool="create_booking"), record)
        == "TOOL_CALLED create_booking"
    )
    assert (
        assertion_failure(Assertion(type="MAX_AGENT_TURNS", value=1), record) == "MAX_AGENT_TURNS 1"
    )
    assert (
        assertion_failure(Assertion(type="UNKNOWN"), record)
        == "UNKNOWN is not a supported assertion"
    )


def test_rubric_parsing_validates_score_range() -> None:
    assert parse_rubric('{"score": 0.8, "notes": "good"}').score == 0.8
    for invalid in ("not json", "[]", '{"score": 1.5}', '{"score": true}'):
        with pytest.raises(ModelError):
            parse_rubric(invalid)


async def test_conversation_uses_fixtures_and_control_tools() -> None:
    model = happy_model()
    record = await ConversationSimulator(
        model, agent_model="agent-model", caller_model="caller-model"
    ).run(scenario(), CONFIG)
    assert record.tools_called == ["check_availability", "end_call"]
    assert (record.outcome, record.intent, record.transferred) == (
        "BOOKING_CREATED",
        "BOOKING",
        False,
    )
    agent_tools = {tool.name for tool in model.calls[0][2]}
    assert agent_tools == {"list_services", "check_availability", "transfer_call", "end_call"}
    tool_message = next(message for message in model.calls[1][1] if message.role == "tool")
    assert json.loads(tool_message.content) == {"slots": ["10:00"]}
    assert [turn.speaker for turn in record.turns] == ["agent", "caller", "agent", "caller"]


async def test_runner_completes_run_with_verdicts() -> None:
    api = FakeApi(
        claim_context((scenario((Assertion(type="TOOL_CALLED", tool="check_availability"),)),))
    )
    runner = SimulationRunner(
        control_api=api,
        secrets=FakeSecrets(),
        model_factory=factory(happy_model),
        models=MODELS,
        scenario_concurrency=2,
    )
    result = await runner.run(JOB, final_attempt=False)
    assert (result.disposition, result.outcome) == ("ACK", "PASSED")
    [results] = api.completed
    assert results[0].verdict == "PASSED"
    assert results[0].tools_called == ("check_availability", "end_call")

    low = FakeApi(claim_context((scenario(),)))
    low_runner = SimulationRunner(
        control_api=low,
        secrets=FakeSecrets(),
        model_factory=factory(lambda: happy_model(0.4)),
        models=MODELS,
        scenario_concurrency=1,
    )
    assert (await low_runner.run(JOB, final_attempt=False)).outcome == "FAILED"
    assert low.completed[0][0].failed_assertions == ("RUBRIC score 0.40 below 0.70",)


async def test_runner_handles_missing_credentials_and_retries() -> None:
    missing = FakeApi(claim_context((scenario(),), with_key=False))
    runner = SimulationRunner(
        control_api=missing,
        secrets=FakeSecrets(),
        model_factory=factory(happy_model),
        models=MODELS,
        scenario_concurrency=1,
    )
    assert (await runner.run(JOB, final_attempt=False)).disposition == "ACK"
    assert missing.failed == ["openai_credentials_missing"]

    unavailable = FakeApi(claim_context((scenario(),)))
    secret_runner = SimulationRunner(
        control_api=unavailable,
        secrets=FakeSecrets(available=False),
        model_factory=factory(happy_model),
        models=MODELS,
        scenario_concurrency=1,
    )
    assert (await secret_runner.run(JOB, final_attempt=False)).disposition == "RETRY"
    assert (await secret_runner.run(JOB, final_attempt=True)).disposition == "ACK"
    assert unavailable.failed == ["openai_credentials_unavailable"]

    flaky = FakeApi(claim_context((scenario(),)))
    exhausted = ScriptedModel({"agent-model": [], "caller-model": [], "judge-model": []})
    flaky_runner = SimulationRunner(
        control_api=flaky,
        secrets=FakeSecrets(),
        model_factory=factory(lambda: exhausted),
        models=MODELS,
        scenario_concurrency=1,
    )
    assert (await flaky_runner.run(JOB, final_attempt=False)).disposition == "RETRY"
    final = await flaky_runner.run(JOB, final_attempt=True)
    assert final.disposition == "ACK"
    assert flaky.completed[-1][0].verdict == "ERRORED"
    assert flaky.completed[-1][0].error_code == "model_unavailable"


def test_decode_job_validates_envelope_and_subject() -> None:
    envelope = {
        "schema_version": 1,
        "event_id": str(uuid.UUID("0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6e")),
        "event_type": "simulation.run_requested",
        "tenant_id": TENANT,
        "trace_id": "b" * 32,
        "occurred_at": "2026-09-15T10:00:00Z",
        "producer": "control-api",
        "payload": {"run_id": RUN, "suite_id": "ignored"},
    }
    data = json.dumps(envelope).encode()
    decoded = decode_job(f"jobs.v1.simulation_run.{TENANT}", data)
    assert decoded.job == SimulationJob(tenant_id=TENANT, run_id=RUN, trace_id="b" * 32)
    assert decode_job("jobs.v1.simulation_run.other", data).reason == "subject_tenant_mismatch"
    assert decode_job(f"jobs.v1.simulation_run.{TENANT}", b"{}").job is None


def test_config_validates_environment() -> None:
    env = {
        "VELYRIC_ENV": "local",
        "VELYRIC_NATS_URL": "nats://127.0.0.1:4222",
        "VELYRIC_CONTROL_API_INTERNAL_URL": "http://127.0.0.1:7101",
        "VELYRIC_PROVIDER_SIMULATOR_URL": "http://127.0.0.1:7900",
        "EVAL_RUNNER_SERVICE_KEY_ID": "eval-runner-local",
        "VELYRIC_SERVICE_SIGNING_KEY_SECRET": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    }
    config = load_config(env, lambda arn: arn)
    assert config.openai_base_url == "http://127.0.0.1:7900/openai/v1"
    assert config.models.pass_score == 0.7
    with pytest.raises(ConfigError) as error:
        load_config(
            {**env, "VELYRIC_ENV": "production", "EVAL_RUNNER_PASS_SCORE_PERCENT": "0"},
            lambda arn: arn,
        )
    assert any(
        "VELYRIC_SERVICE_SIGNING_KEY_SECRET is not allowed" in issue for issue in error.value.issues
    )
    assert any("EVAL_RUNNER_PASS_SCORE_PERCENT" in issue for issue in error.value.issues)
