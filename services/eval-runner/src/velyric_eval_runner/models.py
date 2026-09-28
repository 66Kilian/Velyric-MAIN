from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

import openai

if TYPE_CHECKING:
    from openai.types.chat import ChatCompletionMessageParam, ChatCompletionToolParam

MAX_CACHED_CLIENTS = 128


@dataclass(frozen=True)
class ToolCall:
    call_id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class ChatMessage:
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    tool_calls: tuple[ToolCall, ...] = ()
    tool_call_id: str | None = None


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, object]


@dataclass(frozen=True)
class ModelReply:
    text: str
    tool_calls: tuple[ToolCall, ...]


class ModelError(Exception):
    def __init__(self, code: str, *, retryable: bool) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


class LanguageModel(Protocol):
    async def complete(
        self,
        model: str,
        messages: list[ChatMessage],
        *,
        tools: list[ToolSpec],
        seed: int,
        json_output: bool = False,
    ) -> ModelReply: ...


def _message_param(message: ChatMessage) -> ChatCompletionMessageParam:
    if message.role == "system":
        return {"role": "system", "content": message.content}
    if message.role == "user":
        return {"role": "user", "content": message.content}
    if message.role == "tool":
        return {
            "role": "tool",
            "content": message.content,
            "tool_call_id": message.tool_call_id or "",
        }
    if message.tool_calls:
        return {
            "role": "assistant",
            "content": message.content or None,
            "tool_calls": [
                {
                    "id": call.call_id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
                for call in message.tool_calls
            ],
        }
    return {"role": "assistant", "content": message.content}


def _tool_param(tool: ToolSpec) -> ChatCompletionToolParam:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": json.loads(json.dumps(tool.parameters)),
        },
    }


class OpenAiLanguageModel:
    def __init__(self, base_url: str | None) -> None:
        self._base_url = base_url
        self._clients: dict[str, openai.AsyncOpenAI] = {}
        self._api_key: str | None = None

    def with_key(self, api_key: str) -> OpenAiLanguageModel:
        bound = OpenAiLanguageModel(self._base_url)
        bound._clients = self._clients
        bound._api_key = api_key
        return bound

    def _client(self) -> openai.AsyncOpenAI:
        if self._api_key is None:
            raise ModelError("openai_credentials_missing", retryable=False)
        client = self._clients.get(self._api_key)
        if client is None:
            if len(self._clients) > MAX_CACHED_CLIENTS:
                self._clients.clear()
            client = openai.AsyncOpenAI(
                api_key=self._api_key, base_url=self._base_url, max_retries=3, timeout=60.0
            )
            self._clients[self._api_key] = client
        return client

    async def complete(
        self,
        model: str,
        messages: list[ChatMessage],
        *,
        tools: list[ToolSpec],
        seed: int,
        json_output: bool = False,
    ) -> ModelReply:
        client = self._client()
        try:
            if tools:
                response = await client.chat.completions.create(
                    model=model,
                    messages=[_message_param(message) for message in messages],
                    tools=[_tool_param(tool) for tool in tools],
                    tool_choice="auto",
                    seed=seed,
                    temperature=0.2,
                )
            elif json_output:
                response = await client.chat.completions.create(
                    model=model,
                    messages=[_message_param(message) for message in messages],
                    response_format={"type": "json_object"},
                    seed=seed,
                    temperature=0,
                )
            else:
                response = await client.chat.completions.create(
                    model=model,
                    messages=[_message_param(message) for message in messages],
                    seed=seed,
                    temperature=0.7,
                )
        except openai.RateLimitError as error:
            raise ModelError("model_rate_limited", retryable=True) from error
        except (openai.AuthenticationError, openai.PermissionDeniedError) as error:
            raise ModelError("openai_credentials_rejected", retryable=False) from error
        except openai.BadRequestError as error:
            raise ModelError("model_request_invalid", retryable=False) from error
        except (
            openai.APIConnectionError,
            openai.APITimeoutError,
            openai.InternalServerError,
        ) as error:
            raise ModelError("model_unavailable", retryable=True) from error
        if not response.choices:
            raise ModelError("model_response_empty", retryable=True)
        message = response.choices[0].message
        calls = tuple(
            ToolCall(call_id=call.id, name=call.function.name, arguments=call.function.arguments)
            for call in (message.tool_calls or [])
            if call.type == "function"
        )
        return ModelReply(text=(message.content or "").strip(), tool_calls=calls)
