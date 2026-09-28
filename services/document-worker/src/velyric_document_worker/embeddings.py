from __future__ import annotations

from typing import Protocol

import openai

EMBEDDING_BATCH = 64
MAX_CACHED_CLIENTS = 256


class EmbeddingError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class Embedder(Protocol):
    async def embed(
        self, api_key: str, model: str, dimensions: int, texts: list[str]
    ) -> list[tuple[float, ...]]: ...


class OpenAiEmbedder:
    def __init__(self, base_url: str | None) -> None:
        self._base_url = base_url
        self._clients: dict[str, openai.AsyncOpenAI] = {}

    def _client(self, api_key: str) -> openai.AsyncOpenAI:
        client = self._clients.get(api_key)
        if client is None:
            if len(self._clients) > MAX_CACHED_CLIENTS:
                self._clients.clear()
            client = openai.AsyncOpenAI(
                api_key=api_key, base_url=self._base_url, max_retries=3, timeout=60.0
            )
            self._clients[api_key] = client
        return client

    async def embed(
        self, api_key: str, model: str, dimensions: int, texts: list[str]
    ) -> list[tuple[float, ...]]:
        vectors: list[tuple[float, ...]] = []
        client = self._client(api_key)
        for offset in range(0, len(texts), EMBEDDING_BATCH):
            batch = texts[offset : offset + EMBEDDING_BATCH]
            try:
                response = await client.embeddings.create(
                    model=model, input=batch, dimensions=dimensions, encoding_format="float"
                )
            except openai.RateLimitError as error:
                raise EmbeddingError(
                    "embedding_rate_limited", "OpenAI rate limit reached", retryable=True
                ) from error
            except openai.AuthenticationError as error:
                raise EmbeddingError(
                    "embedding_credentials_rejected",
                    "OpenAI rejected the tenant credentials",
                    retryable=False,
                ) from error
            except openai.PermissionDeniedError as error:
                raise EmbeddingError(
                    "embedding_permission_denied",
                    "OpenAI denied the embedding request",
                    retryable=False,
                ) from error
            except openai.BadRequestError as error:
                raise EmbeddingError(
                    "embedding_request_invalid",
                    "OpenAI rejected the embedding input",
                    retryable=False,
                ) from error
            except (
                openai.APIConnectionError,
                openai.APITimeoutError,
                openai.InternalServerError,
            ) as error:
                raise EmbeddingError(
                    "embedding_unavailable", "OpenAI embeddings are unavailable", retryable=True
                ) from error
            ordered = sorted(response.data, key=lambda item: item.index)
            if len(ordered) != len(batch):
                raise EmbeddingError(
                    "embedding_response_incomplete",
                    "OpenAI returned an incomplete embedding batch",
                    retryable=True,
                )
            for item in ordered:
                vector = tuple(float(value) for value in item.embedding)
                if len(vector) != dimensions:
                    raise EmbeddingError(
                        "embedding_dimension_mismatch",
                        "OpenAI returned vectors with unexpected dimensions",
                        retryable=False,
                    )
                vectors.append(vector)
        return vectors
