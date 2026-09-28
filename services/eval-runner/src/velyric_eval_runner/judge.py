from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING

from velyric_eval_runner.models import ChatMessage, ModelError

if TYPE_CHECKING:
    from velyric_eval_runner.control_api import Assertion, Scenario
    from velyric_eval_runner.conversation import ConversationRecord
    from velyric_eval_runner.models import LanguageModel

RUBRIC = (
    "Score the AI receptionist from 0 to 1 using these criteria with equal weight: "
    "the caller's goal was handled correctly or escalated appropriately; "
    "no facts were invented beyond tool results and configuration; "
    "the agent used the caller's language and a polite, concise phone style; "
    "data-changing actions were confirmed before execution. "
    'Respond with JSON only: {"score": number, "notes": string}.'
)


@dataclass(frozen=True)
class RubricScore:
    score: float
    notes: str


def _agent_text(record: ConversationRecord) -> str:
    return " ".join(turn.text for turn in record.turns if turn.speaker == "agent").casefold()


def assertion_failure(assertion: Assertion, record: ConversationRecord) -> str | None:
    kind = assertion.type
    checks = {
        "OUTCOME_IN": lambda: record.outcome in assertion.values,
        "INTENT_IS": lambda: record.intent == assertion.value,
        "TOOL_CALLED": lambda: assertion.tool in record.tools_called,
        "TOOL_NOT_CALLED": lambda: assertion.tool not in record.tools_called,
        "TRANSFERRED": lambda: record.transferred,
        "NOT_TRANSFERRED": lambda: not record.transferred,
        "PHRASE_PRESENT": lambda: (assertion.phrase or "").casefold() in _agent_text(record),
        "PHRASE_ABSENT": lambda: (assertion.phrase or "").casefold() not in _agent_text(record),
        "MAX_AGENT_TURNS": lambda: (
            isinstance(assertion.value, int) and record.agent_turns <= assertion.value
        ),
    }
    check = checks.get(kind)
    if check is None:
        return f"{kind} is not a supported assertion"
    if check():
        return None
    detail = (
        assertion.tool
        or assertion.phrase
        or (",".join(assertion.values) if assertion.values else None)
    )
    if detail is None and assertion.value is not None:
        detail = str(assertion.value)
    return f"{kind} {detail}" if detail else kind


def failed_assertions(scenario: Scenario, record: ConversationRecord) -> list[str]:
    failures = [
        assertion_failure(assertion, record) for assertion in scenario.deterministic_assertions
    ]
    return [failure for failure in failures if failure is not None]


def parse_rubric(text: str) -> RubricScore:
    try:
        parsed: object = json.loads(text)
    except json.JSONDecodeError as error:
        raise ModelError("judge_response_invalid", retryable=True) from error
    if not isinstance(parsed, dict):
        raise ModelError("judge_response_invalid", retryable=True)
    score = parsed.get("score")
    notes = parsed.get("notes")
    if not isinstance(score, int | float) or isinstance(score, bool) or not 0 <= float(score) <= 1:
        raise ModelError("judge_response_invalid", retryable=True)
    return RubricScore(score=float(score), notes=notes if isinstance(notes, str) else "")


class RubricJudge:
    def __init__(self, model: LanguageModel, *, judge_model: str) -> None:
        self._model = model
        self._judge_model = judge_model

    async def score(self, scenario: Scenario, record: ConversationRecord) -> RubricScore:
        prompt = "\n".join(
            [
                f"Caller goal: {scenario.definition.caller_goal}",
                f"Scenario class: {scenario.scenario_class}",
                f"Tools called: {', '.join(record.tools_called) or 'none'}",
                f"Transferred: {record.transferred}",
                f"Outcome: {record.outcome}; intent: {record.intent}",
                "Transcript:",
                record.transcript(),
            ]
        )
        reply = await self._model.complete(
            self._judge_model,
            [ChatMessage(role="system", content=RUBRIC), ChatMessage(role="user", content=prompt)],
            tools=[],
            seed=scenario.seed,
            json_output=True,
        )
        return parse_rubric(reply.text)
