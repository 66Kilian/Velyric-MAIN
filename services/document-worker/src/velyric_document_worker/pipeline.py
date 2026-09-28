from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol
from urllib.parse import urlsplit

import structlog

from velyric_document_worker.control_api import (
    ChunkPayload,
    ControlApiError,
    IngestionContext,
    ObjectFetch,
    SupersededError,
    UrlFetch,
)
from velyric_document_worker.crawler import discover_pages
from velyric_document_worker.embeddings import Embedder, EmbeddingError
from velyric_document_worker.fetcher import FetchedDocument, FetchError
from velyric_document_worker.parsers import ParseError, parse_document
from velyric_document_worker.structured_facts import location_facts, structured_facts_section
from velyric_document_worker.tenant_secrets import SecretUnavailableError
from velyric_document_worker.text import Chunk, Section, chunk_sections, detect_language, detect_pii

if TYPE_CHECKING:
    from velyric_document_worker.control_api import ControlApiClient
    from velyric_document_worker.scanner import MalwareScanner

log = structlog.get_logger("velyric.document_worker.pipeline")

MAX_OBJECT_BYTES = 50 * 1024 * 1024
MAX_HEADING_PARTS = 8
MAX_HEADING_CHARS = 300
CONTROL_API_RETRY_SECONDS = 30.0
TRANSIENT_RETRY_SECONDS = 60.0


class DocumentSource(Protocol):
    async def fetch(self, url: str, max_bytes: int) -> FetchedDocument: ...


class ObjectSource(Protocol):
    async def download(
        self, url: str, expected_sha256: str | None, expected_size: int | None, max_bytes: int
    ) -> FetchedDocument: ...


class SecretSource(Protocol):
    def read(self, reference: str) -> str: ...


@dataclass(frozen=True)
class IngestionJob:
    tenant_id: str
    source_id: str
    source_version: int
    trace_id: str


@dataclass(frozen=True)
class JobResult:
    disposition: Literal["ACK", "RETRY"]
    outcome: str
    retry_after_seconds: float = 0.0


@dataclass
class _Progress:
    context: IngestionContext | None = None
    version_id: str | None = None


class RetryableIngestionError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class IngestionPipeline:
    def __init__(
        self,
        *,
        control_api: ControlApiClient,
        remote: DocumentSource,
        objects: ObjectSource,
        scanner: MalwareScanner,
        embedder: Embedder,
        secrets: SecretSource,
        ocr_enabled: bool,
    ) -> None:
        self._api = control_api
        self._remote = remote
        self._objects = objects
        self._scanner = scanner
        self._embedder = embedder
        self._secrets = secrets
        self._ocr_enabled = ocr_enabled

    async def run(self, job: IngestionJob, *, final_attempt: bool) -> JobResult:
        progress = _Progress()
        try:
            return await self._process(job, progress, final_attempt=final_attempt)
        except SupersededError:
            log.info("knowledge ingestion superseded", source_id=job.source_id)
            return JobResult(disposition="ACK", outcome="SUPERSEDED")
        except RetryableIngestionError as error:
            return await self._retry_or_fail(job, progress, error.code, final_attempt=final_attempt)
        except (FetchError, EmbeddingError) as error:
            if error.retryable:
                return await self._retry_or_fail(
                    job, progress, error.code, final_attempt=final_attempt
                )
            return await self._fail(job, progress, error.code, retryable=False)
        except ParseError as error:
            return await self._fail(job, progress, error.code, retryable=False)
        except SecretUnavailableError:
            return await self._retry_or_fail(
                job, progress, "embedding_credentials_unavailable", final_attempt=final_attempt
            )
        except ControlApiError as error:
            return self._control_api_failure(job, error, final_attempt=final_attempt)

    async def _process(
        self, job: IngestionJob, progress: _Progress, *, final_attempt: bool
    ) -> JobResult:
        context = await self._api.ingestion_context(
            job.tenant_id, job.source_id, job.source_version, job.trace_id
        )
        progress.context = context
        document = await self._acquire(context)
        scan = await self._scanner.scan(document.body)
        if scan.verdict == "ERROR" and not final_attempt:
            raise RetryableIngestionError("malware_scan_unavailable")
        if scan.verdict != "CLEAN" or context.active_content_sha256 == document.sha256:
            outcome = await self._api.create_version(
                context,
                content_sha256=document.sha256,
                malware_scan_result=scan.verdict,
                parser="clamav" if scan.verdict != "CLEAN" else "unchanged",
                ocr_used=False,
                pii_findings=(),
                detected_language=None,
                trace_id=job.trace_id,
            )
            if scan.verdict != "CLEAN":
                log.warning(
                    "knowledge document rejected",
                    source_id=job.source_id,
                    verdict=scan.verdict,
                    signature=scan.signature,
                )
            return JobResult(disposition="ACK", outcome=outcome.outcome)
        parsed = parse_document(
            context.source.source_type,
            document.body,
            document.content_type,
            ocr_enabled=self._ocr_enabled,
        )
        sections = list(parsed.sections)
        json_ld = list(parsed.json_ld)
        crawled_pages = 0
        if isinstance(context.fetch, UrlFetch) and document.content_type in (
            "text/html",
            "application/xhtml+xml",
        ):
            extra_sections, extra_json_ld, crawled_pages = await self._crawl_site(
                context, document, parsed.links
            )
            sections.extend(extra_sections)
            json_ld.extend(extra_json_ld)
        facts_section = structured_facts_section(json_ld)
        if facts_section is not None:
            sections = [facts_section, *sections]
        extracted_location_facts = location_facts(json_ld)
        chunks = chunk_sections(sections, max_chars=min(4000, context.limits.max_chunk_chars))
        _validate_chunks(chunks, context)
        language = context.source.language or detect_language("\n".join(c.content for c in chunks))
        chunk_pii = [detect_pii(chunk.content) for chunk in chunks]
        embeddings = await self._embed(context, chunks)
        outcome = await self._api.create_version(
            context,
            content_sha256=document.sha256,
            malware_scan_result="CLEAN",
            parser=parsed.parser,
            ocr_used=parsed.ocr_used,
            pii_findings=tuple(sorted({flag for flags in chunk_pii for flag in flags})),
            detected_language=language,
            trace_id=job.trace_id,
        )
        if outcome.outcome not in ("CREATED", "RESUMED"):
            return JobResult(disposition="ACK", outcome=outcome.outcome)
        progress.version_id = outcome.version_id
        payloads = [
            ChunkPayload(
                chunk_index=chunk.index,
                content=chunk.content,
                token_count=chunk.token_count,
                language=language,
                heading_path=tuple(
                    part[:MAX_HEADING_CHARS] for part in chunk.heading_path[:MAX_HEADING_PARTS]
                ),
                metadata={"page": chunk.page} if chunk.page is not None else {},
                pii_flags=chunk_pii[chunk.index],
                embedding=embeddings[chunk.index] if embeddings is not None else None,
            )
            for chunk in chunks
        ]
        batch = context.limits.max_chunks_per_batch
        for offset in range(0, len(payloads), batch):
            await self._api.upload_chunks(
                context, outcome.version_id, payloads[offset : offset + batch], job.trace_id
            )
        await self._api.complete_version(
            context,
            outcome.version_id,
            len(payloads),
            job.trace_id,
            extracted_location_facts=extracted_location_facts,
        )
        log.info(
            "knowledge source version activated",
            source_id=job.source_id,
            version_id=outcome.version_id,
            chunks=len(payloads),
            parser=parsed.parser,
            crawled_pages=crawled_pages,
        )
        return JobResult(disposition="ACK", outcome="ACTIVATED")

    async def _crawl_site(
        self, context: IngestionContext, seed: FetchedDocument, seed_links: tuple[str, ...]
    ) -> tuple[list[Section], list[str], int]:
        """Best-effort same-site crawl beyond the seed page.

        Runs after the seed page is confirmed clean; each discovered page is scanned
        and parsed independently, and a page that fails to scan clean or fails to parse
        is simply dropped rather than failing the whole ingestion.
        """
        try:
            pages = await discover_pages(self._remote, seed.final_url, seed_links)
        except Exception:
            log.warning("website crawl failed", source_id=context.source.id, exc_info=True)
            return [], [], 0
        sections: list[Section] = []
        json_ld: list[str] = []
        accepted = 0
        for page in pages:
            try:
                scan = await self._scanner.scan(page.document.body)
            except Exception:
                log.warning("crawled page scan failed", url=page.url, exc_info=True)
                continue
            if scan.verdict != "CLEAN":
                continue
            try:
                parsed = parse_document(
                    context.source.source_type,
                    page.document.body,
                    page.document.content_type,
                    ocr_enabled=self._ocr_enabled,
                )
            except ParseError:
                continue
            label = urlsplit(page.url).path.strip("/").replace("-", " ").replace("/", " · ")
            for section in parsed.sections:
                heading = (label, *section.heading_path) if label else section.heading_path
                sections.append(Section(heading_path=heading, text=section.text))
            json_ld.extend(parsed.json_ld)
            accepted += 1
        return sections, json_ld, accepted

    async def _embed(
        self, context: IngestionContext, chunks: list[Chunk]
    ) -> list[tuple[float, ...]] | None:
        if not context.embedding.required:
            return None
        if context.embedding.api_key is None:
            raise ParseError("embedding_credentials_missing", "the tenant has no active OpenAI key")
        api_key = self._secrets.read(context.embedding.api_key.secret_ref)
        return await self._embedder.embed(
            api_key,
            context.embedding.model,
            context.embedding.dimensions,
            [chunk.content for chunk in chunks],
        )

    async def _acquire(self, context: IngestionContext) -> FetchedDocument:
        fetch = context.fetch
        if isinstance(fetch, ObjectFetch):
            return await self._objects.download(
                fetch.url, fetch.expected_sha256, fetch.size_bytes, MAX_OBJECT_BYTES
            )
        return await self._remote.fetch(fetch.uri, fetch.max_bytes)

    def _control_api_failure(
        self, job: IngestionJob, error: ControlApiError, *, final_attempt: bool
    ) -> JobResult:
        if error.retryable and not final_attempt:
            log.warning(
                "control-api call failed; retrying", source_id=job.source_id, status=error.status
            )
            return JobResult(
                disposition="RETRY",
                outcome="CONTROL_API_UNAVAILABLE",
                retry_after_seconds=CONTROL_API_RETRY_SECONDS,
            )
        log.error(
            "control-api rejected the ingestion",
            source_id=job.source_id,
            status=error.status,
            code=error.code,
        )
        return JobResult(disposition="ACK", outcome="CONTROL_API_REJECTED")

    async def _retry_or_fail(
        self, job: IngestionJob, progress: _Progress, code: str, *, final_attempt: bool
    ) -> JobResult:
        if not final_attempt:
            log.warning(
                "knowledge ingestion failed transiently", source_id=job.source_id, code=code
            )
            return JobResult(
                disposition="RETRY", outcome=code, retry_after_seconds=TRANSIENT_RETRY_SECONDS
            )
        return await self._fail(job, progress, code, retryable=True)

    async def _fail(
        self, job: IngestionJob, progress: _Progress, code: str, *, retryable: bool
    ) -> JobResult:
        try:
            await self._api.report_failure(
                progress.context,
                tenant_id=job.tenant_id,
                source_id=job.source_id,
                source_version=job.source_version,
                error_code=code,
                version_id=progress.version_id,
                retryable=retryable,
                trace_id=job.trace_id,
            )
        except SupersededError:
            return JobResult(disposition="ACK", outcome="SUPERSEDED")
        except ControlApiError as error:
            if error.retryable:
                return JobResult(
                    disposition="RETRY",
                    outcome="FAILURE_REPORT_PENDING",
                    retry_after_seconds=CONTROL_API_RETRY_SECONDS,
                )
        log.warning(
            "knowledge ingestion failed", source_id=job.source_id, code=code, retryable=retryable
        )
        return JobResult(disposition="ACK", outcome=f"FAILED:{code}")


def _validate_chunks(chunks: list[Chunk], context: IngestionContext) -> None:
    if not chunks:
        raise ParseError("no_extractable_text", "the document contains no extractable text")
    if len(chunks) > context.limits.max_chunks:
        raise ParseError("too_many_chunks", "the document is too large for the knowledge base")
