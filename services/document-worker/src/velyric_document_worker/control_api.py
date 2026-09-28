from __future__ import annotations

import secrets
from dataclasses import dataclass
from http import HTTPStatus
from typing import TYPE_CHECKING, Annotated, Literal

import httpx
from pydantic import Field, TypeAdapter, ValidationError

if TYPE_CHECKING:
    from velyric_document_worker.service_token import ServiceTokenSigner

JsonScalar = str | int | float | bool | None


@dataclass(frozen=True)
class SourceInfo:
    id: str
    tenant_id: str
    source_type: str
    source_version: int
    title: str
    mime_type: str | None
    language: str | None
    location_id: str | None


@dataclass(frozen=True)
class ObjectFetch:
    kind: Literal["OBJECT"]
    url: str
    expires_at: str
    expected_sha256: str | None
    size_bytes: int | None


@dataclass(frozen=True)
class UrlFetch:
    kind: Literal["URL"]
    uri: str
    max_bytes: int


@dataclass(frozen=True)
class SecretReference:
    secret_ref: str
    secret_version: int


@dataclass(frozen=True)
class EmbeddingSpec:
    model: str
    dimensions: int
    required: bool
    api_key: SecretReference | None


@dataclass(frozen=True)
class Limits:
    max_chunks: int
    max_chunks_per_batch: int
    max_chunk_chars: int


@dataclass(frozen=True)
class IngestionContext:
    source: SourceInfo
    fetch: Annotated[ObjectFetch | UrlFetch, Field(discriminator="kind")]
    active_content_sha256: str | None
    embedding: EmbeddingSpec
    limits: Limits


@dataclass(frozen=True)
class VersionOutcome:
    outcome: Literal["CREATED", "RESUMED", "UNCHANGED", "QUARANTINED", "FAILED"]
    version_id: str
    version_number: int | None = None


@dataclass(frozen=True)
class ChunkPayload:
    chunk_index: int
    content: str
    token_count: int
    language: str | None
    heading_path: tuple[str, ...]
    metadata: dict[str, JsonScalar]
    pii_flags: tuple[str, ...]
    embedding: tuple[float, ...] | None

    def as_json(self) -> dict[str, object]:
        body: dict[str, object] = {
            "chunk_index": self.chunk_index,
            "content": self.content,
            "token_count": self.token_count,
            "heading_path": list(self.heading_path),
            "metadata": self.metadata,
            "pii_flags": list(self.pii_flags),
        }
        if self.language is not None:
            body["language"] = self.language
        if self.embedding is not None:
            body["embedding"] = [round(value, 7) for value in self.embedding]
        return body


class ControlApiError(Exception):
    def __init__(
        self, message: str, *, status: int | None, code: str | None, retryable: bool
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable


class SupersededError(ControlApiError):
    pass


_RETRYABLE_STATUSES = frozenset(
    {HTTPStatus.REQUEST_TIMEOUT, HTTPStatus.TOO_EARLY, HTTPStatus.TOO_MANY_REQUESTS}
)

_error_adapter: TypeAdapter[dict[str, object]] = TypeAdapter(dict[str, object])
_context_adapter: TypeAdapter[IngestionContext] = TypeAdapter(IngestionContext)
_outcome_adapter: TypeAdapter[VersionOutcome] = TypeAdapter(VersionOutcome)


class ControlApiClient:
    def __init__(
        self, base_url: str, signer: ServiceTokenSigner, client: httpx.AsyncClient
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._signer = signer
        self._client = client

    async def _request(
        self,
        method: str,
        path: str,
        *,
        tenant_id: str,
        scope: str,
        trace_id: str,
        body: dict[str, object] | None = None,
        params: dict[str, str] | None = None,
    ) -> bytes:
        token = self._signer.sign(audience="control-api", scopes=(scope,), tenant_id=tenant_id)
        headers = {
            "authorization": f"Bearer {token}",
            "traceparent": f"00-{trace_id}-{secrets.token_hex(8)}-01",
        }
        try:
            response = await self._client.request(
                method,
                f"{self._base_url}{path}",
                headers=headers,
                json=body,
                params=params,
                timeout=30.0,
            )
        except httpx.HTTPError as error:
            msg = f"control-api request failed: {type(error).__name__}"
            raise ControlApiError(msg, status=None, code=None, retryable=True) from error
        if response.is_success:
            return response.content
        code: str | None = None
        details: dict[str, object] = {}
        try:
            envelope = _error_adapter.validate_json(response.content)
            raw_code = envelope.get("code")
            code = raw_code if isinstance(raw_code, str) else None
            raw_details = envelope.get("details")
            if isinstance(raw_details, dict):
                details = {str(key): value for key, value in raw_details.items()}
        except ValidationError:
            code = None
        message = (
            f"control-api {method} {path} returned {response.status_code} {code or ''}".strip()
        )
        if response.status_code == HTTPStatus.CONFLICT and details.get("reason") == "superseded":
            raise SupersededError(message, status=409, code=code, retryable=False)
        retryable = response.status_code in _RETRYABLE_STATUSES or response.is_server_error
        raise ControlApiError(message, status=response.status_code, code=code, retryable=retryable)

    async def ingestion_context(
        self, tenant_id: str, source_id: str, source_version: int, trace_id: str
    ) -> IngestionContext:
        content = await self._request(
            "GET",
            f"/internal/v1/knowledge/ingestions/{source_id}",
            tenant_id=tenant_id,
            scope="knowledge.ingest",
            trace_id=trace_id,
            params={"source_version": str(source_version)},
        )
        return _context_adapter.validate_json(content)

    async def create_version(
        self,
        context: IngestionContext,
        *,
        content_sha256: str,
        malware_scan_result: Literal["CLEAN", "INFECTED", "ERROR"],
        parser: str,
        ocr_used: bool,
        pii_findings: tuple[str, ...],
        detected_language: str | None,
        trace_id: str,
    ) -> VersionOutcome:
        body: dict[str, object] = {
            "source_version": context.source.source_version,
            "content_sha256": content_sha256,
            "malware_scan_result": malware_scan_result,
            "parser": parser,
            "ocr_used": ocr_used,
            "pii_findings": sorted(set(pii_findings)),
        }
        if detected_language is not None:
            body["detected_language"] = detected_language
        content = await self._request(
            "POST",
            f"/internal/v1/knowledge/ingestions/{context.source.id}/versions",
            tenant_id=context.source.tenant_id,
            scope="knowledge.ingest",
            trace_id=trace_id,
            body=body,
        )
        return _outcome_adapter.validate_json(content)

    async def upload_chunks(
        self, context: IngestionContext, version_id: str, chunks: list[ChunkPayload], trace_id: str
    ) -> None:
        await self._request(
            "POST",
            f"/internal/v1/knowledge/versions/{version_id}/chunks",
            tenant_id=context.source.tenant_id,
            scope="knowledge.ingest",
            trace_id=trace_id,
            body={
                "embedding_model": context.embedding.model,
                "chunks": [chunk.as_json() for chunk in chunks],
            },
        )

    async def complete_version(
        self,
        context: IngestionContext,
        version_id: str,
        chunk_count: int,
        trace_id: str,
        extracted_location_facts: dict[str, object] | None = None,
    ) -> None:
        body: dict[str, object] = {"chunk_count": chunk_count}
        if extracted_location_facts is not None:
            body["extracted_location_facts"] = extracted_location_facts
        await self._request(
            "POST",
            f"/internal/v1/knowledge/versions/{version_id}/complete",
            tenant_id=context.source.tenant_id,
            scope="knowledge.ingest",
            trace_id=trace_id,
            body=body,
        )

    async def report_failure(
        self,
        context: IngestionContext | None,
        *,
        tenant_id: str,
        source_id: str,
        source_version: int,
        error_code: str,
        version_id: str | None,
        retryable: bool,
        trace_id: str,
    ) -> None:
        body: dict[str, object] = {
            "source_version": context.source.source_version if context else source_version,
            "error_code": error_code,
            "retryable": retryable,
        }
        if version_id is not None:
            body["version_id"] = version_id
        await self._request(
            "POST",
            f"/internal/v1/knowledge/ingestions/{source_id}/failures",
            tenant_id=tenant_id,
            scope="knowledge.ingest",
            trace_id=trace_id,
            body=body,
        )
