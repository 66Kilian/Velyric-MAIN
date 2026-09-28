from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from velyric_eval_runner.generated.enums import CallIntentCategory, CallOutcome
from velyric_eval_runner.models import ChatMessage, ModelReply, ToolCall, ToolSpec

if TYPE_CHECKING:
    from velyric_eval_runner.control_api import Scenario, ToolFixture
    from velyric_eval_runner.models import LanguageModel

END_MARKER = "[END]"
TRANSFER_TOOL = "transfer_call"
END_TOOL = "end_call"
MAX_TOOL_ROUNDS_PER_TURN = 5
_LANGUAGE_NAMES = {"hu": "Hungarian", "de": "German", "en": "English"}

_CONTROL_TOOLS = (
    ToolSpec(
        name=TRANSFER_TOOL,
        description="Transfer the caller to a human destination configured for this business.",
        parameters={
            "type": "object",
            "properties": {
                "destination_label": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["destination_label", "reason"],
            "additionalProperties": False,
        },
    ),
    ToolSpec(
        name=END_TOOL,
        description="End the call once the caller's request is handled or cannot be handled.",
        parameters={
            "type": "object",
            "properties": {
                "outcome": {"type": "string", "enum": [item.value for item in CallOutcome]},
                "intent": {"type": "string", "enum": [item.value for item in CallIntentCategory]},
            },
            "required": ["outcome", "intent"],
            "additionalProperties": False,
        },
    ),
)


@dataclass(frozen=True)
class Turn:
    speaker: str
    text: str


@dataclass
class ConversationRecord:
    turns: list[Turn] = field(default_factory=list)
    tools_called: list[str] = field(default_factory=list)
    transferred: bool = False
    outcome: str | None = None
    intent: str | None = None

    @property
    def agent_turns(self) -> int:
        return sum(1 for turn in self.turns if turn.speaker == "agent")

    def transcript(self) -> str:
        return "\n".join(f"{turn.speaker.upper()}: {turn.text}" for turn in self.turns)


def _mapping(value: object) -> dict[str, object]:
    return {str(key): item for key, item in value.items()} if isinstance(value, dict) else {}


def _sequence(value: object) -> list[object]:
    return list(value) if isinstance(value, list) else []


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def allowed_tools(config: dict[str, object]) -> list[str]:
    names: list[str] = []
    for specialist in _sequence(config.get("specialists")):
        entry = _mapping(specialist)
        if entry.get("enabled") is not True:
            continue
        for tool in _sequence(entry.get("tool_allowlist")):
            if isinstance(tool, str) and tool not in names:
                names.append(tool)
    return names


def opening_for(config: dict[str, object], language: str) -> str:
    greeting = ""
    for entry in _sequence(config.get("languages")):
        item = _mapping(entry)
        if item.get("locale") == language:
            greeting = _text(item.get("greeting"))
    disclosure = _text(_mapping(_mapping(config.get("disclosure")).get("texts")).get(language))
    return " ".join(part for part in (disclosure, greeting) if part)


def agent_instructions(config: dict[str, object], language: str) -> str:
    persona = _mapping(config.get("persona"))
    traits = ", ".join(
        f"{key} {value}/100" for key, value in persona.items() if isinstance(value, int)
    )
    destinations = [
        f"{_text(_mapping(item).get('label'))}: {_text(_mapping(item).get('description'))}"
        for item in _sequence(_mapping(config.get("handoff")).get("destinations"))
    ]
    hours = []
    for item in _sequence(config.get("business_hours")):
        entry = _mapping(item)
        opens, closes = _text(entry.get("opens")), _text(entry.get("closes"))
        hours.append(f"day {entry.get('iso_weekday')} {opens}-{closes}")
    language_name = _LANGUAGE_NAMES.get(language, "the caller language")
    timezone = _text(config.get("timezone"))
    lines = [
        "You are the AI phone receptionist of a business, evaluated in a text simulation.",
        f"Speak {language_name} unless the caller switches language.",
        "Keep replies short and natural for a phone call.",
        "Never invent prices, availability or policies: use the available tools instead.",
        "Confirm details before any action that changes data.",
        f"Persona: {traits or 'warm and professional'}.",
        f"Business hours ({timezone}): {'; '.join(hours) or 'not configured'}.",
        f"Human transfer destinations: {'; '.join(destinations) or 'none, take a message'}.",
        f"Call {TRANSFER_TOOL} when the caller needs a human.",
        f"Call {END_TOOL} when the call is finished.",
    ]
    return "\n".join(lines)


def caller_instructions(scenario: Scenario) -> str:
    definition = scenario.definition
    facts = "; ".join(f"{key}: {value}" for key, value in definition.caller_facts.items())
    return "\n".join(
        [
            "You are simulating a person calling a business on the phone.",
            f"Your goal: {definition.caller_goal}",
            f"Persona: {definition.caller_persona or 'an ordinary, polite caller'}.",
            f"Facts you know and may share when asked: {facts or 'none'}.",
            f"Speak only {_LANGUAGE_NAMES.get(scenario.language, 'the scenario language')}.",
            "Reply with exactly what you would say next, in one or two sentences.",
            f"When your goal is achieved or the call is over, reply with exactly {END_MARKER}.",
        ]
    )


def fixture_result(fixtures: tuple[ToolFixture, ...], name: str, used: dict[str, int]) -> str:
    matching = [fixture for fixture in fixtures if fixture.tool == name]
    if not matching:
        return json.dumps({"error": "TOOL_UNAVAILABLE"})
    index = min(used.get(name, 0), len(matching) - 1)
    used[name] = used.get(name, 0) + 1
    fixture = matching[index]
    if fixture.error_code is not None:
        return json.dumps({"error": fixture.error_code})
    return json.dumps(fixture.response or {"ok": True})


class ConversationSimulator:
    def __init__(self, model: LanguageModel, *, agent_model: str, caller_model: str) -> None:
        self._model = model
        self._agent_model = agent_model
        self._caller_model = caller_model

    async def run(self, scenario: Scenario, config: dict[str, object]) -> ConversationRecord:
        record = ConversationRecord()
        tool_names = allowed_tools(config)
        tools = [
            ToolSpec(
                name=name,
                description=f"Business tool {name}. Pass arguments as a JSON object.",
                parameters={"type": "object", "additionalProperties": True},
            )
            for name in tool_names
        ] + list(_CONTROL_TOOLS)
        agent_messages = [
            ChatMessage(role="system", content=agent_instructions(config, scenario.language))
        ]
        opening = opening_for(config, scenario.language)
        if opening:
            agent_messages.append(ChatMessage(role="assistant", content=opening))
            record.turns.append(Turn(speaker="agent", text=opening))
        caller_text = scenario.definition.opening_line
        used: dict[str, int] = {}
        for turn in range(scenario.definition.max_turns):
            record.turns.append(Turn(speaker="caller", text=caller_text))
            agent_messages.append(ChatMessage(role="user", content=caller_text))
            finished = await self._agent_turn(scenario, agent_messages, tools, record, used, turn)
            if finished:
                break
            caller_text = await self._caller_turn(scenario, record, turn)
            if caller_text in ("", END_MARKER):
                break
        return record

    async def _agent_turn(
        self,
        scenario: Scenario,
        messages: list[ChatMessage],
        tools: list[ToolSpec],
        record: ConversationRecord,
        used: dict[str, int],
        turn: int,
    ) -> bool:
        for round_index in range(MAX_TOOL_ROUNDS_PER_TURN):
            reply = await self._model.complete(
                self._agent_model,
                messages,
                tools=tools,
                seed=scenario.seed + turn * 31 + round_index,
            )
            if not reply.tool_calls:
                if reply.text:
                    messages.append(ChatMessage(role="assistant", content=reply.text))
                    record.turns.append(Turn(speaker="agent", text=reply.text))
                return False
            messages.append(
                ChatMessage(role="assistant", content=reply.text, tool_calls=reply.tool_calls)
            )
            if reply.text:
                record.turns.append(Turn(speaker="agent", text=reply.text))
            if self._apply_tools(scenario, reply, messages, record, used):
                return True
        return False

    def _apply_tools(
        self,
        scenario: Scenario,
        reply: ModelReply,
        messages: list[ChatMessage],
        record: ConversationRecord,
        used: dict[str, int],
    ) -> bool:
        finished = False
        for call in reply.tool_calls:
            record.tools_called.append(call.name)
            if call.name == TRANSFER_TOOL:
                record.transferred = True
                finished = True
                messages.append(_tool_message(call, {"status": "TRANSFERRING"}))
            elif call.name == END_TOOL:
                arguments = _arguments(call)
                record.outcome = _text(arguments.get("outcome")) or None
                record.intent = _text(arguments.get("intent")) or None
                finished = True
                messages.append(_tool_message(call, {"status": "ENDED"}))
            else:
                messages.append(
                    ChatMessage(
                        role="tool",
                        content=fixture_result(scenario.definition.tool_fixtures, call.name, used),
                        tool_call_id=call.call_id,
                    )
                )
        return finished

    async def _caller_turn(self, scenario: Scenario, record: ConversationRecord, turn: int) -> str:
        messages = [ChatMessage(role="system", content=caller_instructions(scenario))]
        messages.extend(
            ChatMessage(role="assistant", content=entry.text)
            if entry.speaker == "caller"
            else ChatMessage(role="user", content=entry.text)
            for entry in record.turns
        )
        reply = await self._model.complete(
            self._caller_model, messages, tools=[], seed=scenario.seed + 7919 + turn
        )
        return reply.text.strip()


def _tool_message(call: ToolCall, payload: dict[str, object]) -> ChatMessage:
    return ChatMessage(role="tool", content=json.dumps(payload), tool_call_id=call.call_id)


def _arguments(call: ToolCall) -> dict[str, object]:
    try:
        parsed: object = json.loads(call.arguments or "{}")
    except json.JSONDecodeError:
        return {}
    return _mapping(parsed)
