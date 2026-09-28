from __future__ import annotations

import asyncio
import hashlib
import json
import struct
from dataclasses import dataclass, field

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from velyric_document_worker.consumer import decode_job
from velyric_document_worker.control_api import ControlApiClient
from velyric_document_worker.embeddings import EmbeddingError
from velyric_document_worker.fetcher import FetchedDocument, FetchError
from velyric_document_worker.health import HealthServer
from velyric_document_worker.pipeline import IngestionJob, IngestionPipeline
from velyric_document_worker.scanner import ClamdScanner, ScanResult
from velyric_document_worker.service_token import ServiceTokenSigner

TENANT = "0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f"
SOURCE = "0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e60"
TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
PEM = (
    Ed25519PrivateKey.generate()
    .private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    .decode()
)
DOCUMENT = (
    "# Rendelési idő\n\nA rendelő hétfőtől péntekig 8 és 18 óra között van nyitva, és szombaton zárva tart.\n\n"
    "# Parkolás\n\nAz udvarban ingyenes a parkolás, de csak ha van szabad hely. Kérdés esetén írjon a recepcio@rendelo.hu címre."
).encode()


@dataclass
class FakeControlApi:
    source_version: int = 1
    required_embeddings: bool = True
    active_sha: str | None = None
    superseded: bool = False
    versions: list[dict[str, object]] = field(default_factory=list)
    chunks: list[dict[str, object]] = field(default_factory=list)
    completed: list[dict[str, object]] = field(default_factory=list)
    failures: list[dict[str, object]] = field(default_factory=list)
    requests: list[httpx.Request] = field(default_factory=list)
    version_status: int = 201

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if self.superseded:
            return httpx.Response(
                409,
                json={
                    "code": "CONFLICT",
                    "details": {"reason": "superseded", "current_version": 2},
                },
            )
        if request.method == "GET" and path == f"/internal/v1/knowledge/ingestions/{SOURCE}":
            return httpx.Response(
                200,
                json={
                    "source": {
                        "id": SOURCE,
                        "tenant_id": TENANT,
                        "source_type": "FILE_MARKDOWN",
                        "source_version": self.source_version,
                        "title": "GYIK",
                        "mime_type": "text/markdown",
                        "language": None,
                        "location_id": None,
                    },
                    "fetch": {
                        "kind": "OBJECT",
                        "url": "https://bucket.s3.test/object?sig=1",
                        "expires_at": "2030-01-01T00:00:00.000Z",
                        "expected_sha256": hashlib.sha256(DOCUMENT).hexdigest(),
                        "size_bytes": len(DOCUMENT),
                    },
                    "active_content_sha256": self.active_sha,
                    "embedding": {
                        "model": "text-embedding-3-small",
                        "dimensions": 4,
                        "required": self.required_embeddings,
                        "api_key": {
                            "secret_ref": "local-vault://tenants/t/openai/v1",
                            "secret_version": 1,
                        },
                    },
                    "limits": {
                        "max_chunks": 100,
                        "max_chunks_per_batch": 1,
                        "max_chunk_chars": 16000,
                    },
                },
            )
        body = json.loads(request.content) if request.content else {}
        if path.endswith("/versions"):
            self.versions.append(body)
            if body["malware_scan_result"] == "INFECTED":
                return httpx.Response(200, json={"outcome": "QUARANTINED", "version_id": "v-q"})
            if body["content_sha256"] == self.active_sha:
                return httpx.Response(200, json={"outcome": "UNCHANGED", "version_id": "v-active"})
            if self.version_status >= 500:
                return httpx.Response(self.version_status, json={"code": "SERVICE_UNAVAILABLE"})
            return httpx.Response(
                201, json={"outcome": "CREATED", "version_id": "v-1", "version_number": 1}
            )
        if path.endswith("/chunks"):
            self.chunks.extend(body["chunks"])
            return httpx.Response(
                200,
                json={
                    "accepted": len(body["chunks"]),
                    "inserted": len(body["chunks"]),
                    "embeddings_stored": True,
                },
            )
        if path.endswith("/complete"):
            self.completed.append(body)
            return httpx.Response(
                200,
                json={
                    "outcome": "ACTIVATED",
                    "version_id": "v-1",
                    "chunk_count": body["chunk_count"],
                },
            )
        if path.endswith("/failures"):
            self.failures.append(body)
            return httpx.Response(200, json={"outcome": "FAILED", "still_serving_version_id": None})
        return httpx.Response(404, json={"code": "NOT_FOUND"})


class FakeObjects:
    def __init__(self, body: bytes = DOCUMENT, error: FetchError | None = None) -> None:
        self.body = body
        self.error = error

    async def download(
        self, url: str, expected_sha256: str | None, expected_size: int | None, max_bytes: int
    ) -> FetchedDocument:
        assert url.startswith("https://bucket.s3.test/")
        assert expected_size == len(DOCUMENT)
        assert max_bytes > 0
        if self.error is not None:
            raise self.error
        digest = hashlib.sha256(self.body).hexdigest()
        assert expected_sha256 == digest
        return FetchedDocument(
            body=self.body, content_type="text/markdown", sha256=digest, final_url=url
        )


class FakeRemote:
    async def fetch(self, url: str, max_bytes: int) -> FetchedDocument:
        raise AssertionError((url, max_bytes))


class FakeScanner:
    def __init__(self, verdict: str = "CLEAN") -> None:
        self.verdict = verdict

    async def scan(self, body: bytes) -> ScanResult:
        assert body
        if self.verdict == "INFECTED":
            return ScanResult(verdict="INFECTED", signature="Eicar-Test-Signature")
        if self.verdict == "ERROR":
            return ScanResult(verdict="ERROR", signature=None)
        return ScanResult(verdict="CLEAN", signature=None)


class FakeEmbedder:
    def __init__(self, error: EmbeddingError | None = None) -> None:
        self.calls: list[tuple[str, list[str]]] = []
        self.error = error

    async def embed(
        self, api_key: str, model: str, dimensions: int, texts: list[str]
    ) -> list[tuple[float, ...]]:
        assert model == "text-embedding-3-small"
        if self.error is not None:
            raise self.error
        self.calls.append((api_key, texts))
        return [
            tuple(float(index + position) / 10 for position in range(dimensions))
            for index in range(len(texts))
        ]


class FakeSecrets:
    def read(self, reference: str) -> str:
        assert reference == "local-vault://tenants/t/openai/v1"
        return "sk-tenant-key"


def pipeline(
    api: FakeControlApi,
    *,
    objects: FakeObjects | None = None,
    scanner: FakeScanner | None = None,
    embedder: FakeEmbedder | None = None,
) -> IngestionPipeline:
    client = ControlApiClient(
        "http://control-api.test",
        ServiceTokenSigner(PEM, "document-worker-test"),
        httpx.AsyncClient(transport=httpx.MockTransport(api.handler)),
    )
    return IngestionPipeline(
        control_api=client,
        remote=FakeRemote(),
        objects=objects or FakeObjects(),
        scanner=scanner or FakeScanner(),
        embedder=embedder or FakeEmbedder(),
        secrets=FakeSecrets(),
        ocr_enabled=False,
    )


JOB = IngestionJob(tenant_id=TENANT, source_id=SOURCE, source_version=1, trace_id=TRACE)


async def test_uploaded_document_is_parsed_embedded_uploaded_in_batches_and_activated() -> None:
    api = FakeControlApi()
    embedder = FakeEmbedder()
    result = await pipeline(api, embedder=embedder).run(JOB, final_attempt=False)
    assert (result.disposition, result.outcome) == ("ACK", "ACTIVATED")
    assert api.versions[0]["parser"] == "markdown-it"
    assert api.versions[0]["pii_findings"] == ["EMAIL"]
    assert api.versions[0]["detected_language"] == "hu"
    assert [chunk["chunk_index"] for chunk in api.chunks] == [0, 1]
    assert api.chunks[0]["heading_path"] == ["Rendelési idő"]
    assert api.chunks[1]["pii_flags"] == ["EMAIL"]
    assert api.chunks[1]["embedding"] == [0.1, 0.2, 0.3, 0.4]
    assert api.completed == [{"chunk_count": 2}]
    assert embedder.calls[0][0] == "sk-tenant-key"
    authorization = api.requests[0].headers["authorization"]
    assert authorization.startswith("Bearer ")
    assert "sk-tenant-key" not in json.dumps([request.content.decode() for request in api.requests])
    assert api.requests[0].headers["traceparent"].startswith(f"00-{TRACE}-")


async def test_infected_documents_are_reported_and_never_parsed() -> None:
    api = FakeControlApi()
    embedder = FakeEmbedder()
    result = await pipeline(api, scanner=FakeScanner("INFECTED"), embedder=embedder).run(
        JOB, final_attempt=False
    )
    assert result.outcome == "QUARANTINED"
    assert api.versions[0]["malware_scan_result"] == "INFECTED"
    assert api.chunks == []
    assert embedder.calls == []


async def test_scanner_outage_retries_until_the_final_attempt() -> None:
    api = FakeControlApi()
    first = await pipeline(api, scanner=FakeScanner("ERROR")).run(JOB, final_attempt=False)
    assert (first.disposition, first.outcome) == ("RETRY", "malware_scan_unavailable")
    assert api.versions == []
    final = await pipeline(api, scanner=FakeScanner("ERROR")).run(JOB, final_attempt=True)
    assert final.disposition == "ACK"
    assert api.versions[0]["malware_scan_result"] == "ERROR"


async def test_unchanged_content_skips_parsing_and_embedding() -> None:
    api = FakeControlApi(active_sha=hashlib.sha256(DOCUMENT).hexdigest())
    embedder = FakeEmbedder()
    result = await pipeline(api, embedder=embedder).run(JOB, final_attempt=False)
    assert result.outcome == "UNCHANGED"
    assert embedder.calls == []


async def test_superseded_jobs_are_acknowledged_without_side_effects() -> None:
    api = FakeControlApi(superseded=True)
    result = await pipeline(api).run(JOB, final_attempt=False)
    assert (result.disposition, result.outcome) == ("ACK", "SUPERSEDED")


async def test_permanent_failures_are_reported_and_transient_ones_retried() -> None:
    api = FakeControlApi()
    unreadable = await pipeline(
        api,
        objects=FakeObjects(error=FetchError("object_checksum_mismatch", "bad", retryable=False)),
    ).run(JOB, final_attempt=False)
    assert unreadable.outcome == "FAILED:object_checksum_mismatch"
    assert api.failures == [
        {"source_version": 1, "error_code": "object_checksum_mismatch", "retryable": False}
    ]

    api = FakeControlApi()
    limited = await pipeline(
        api, embedder=FakeEmbedder(EmbeddingError("embedding_rate_limited", "slow", retryable=True))
    ).run(JOB, final_attempt=False)
    assert (limited.disposition, limited.outcome) == ("RETRY", "embedding_rate_limited")
    assert api.failures == []
    exhausted = await pipeline(
        api, embedder=FakeEmbedder(EmbeddingError("embedding_rate_limited", "slow", retryable=True))
    ).run(JOB, final_attempt=True)
    assert exhausted.outcome == "FAILED:embedding_rate_limited"
    assert api.failures[0]["retryable"] is True

    api = FakeControlApi(version_status=503)
    unavailable = await pipeline(api).run(JOB, final_attempt=False)
    assert (unavailable.disposition, unavailable.outcome) == ("RETRY", "CONTROL_API_UNAVAILABLE")


def test_job_envelopes_are_strictly_validated() -> None:
    envelope = {
        "schema_version": 1,
        "event_id": "0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e61",
        "event_type": "knowledge.ingestion_requested",
        "tenant_id": TENANT,
        "trace_id": TRACE,
        "occurred_at": "2026-09-14T08:00:00.000Z",
        "producer": "control-api",
        "payload": {
            "tenant_id": TENANT,
            "source_id": SOURCE,
            "source_version": 3,
            "source_type": "URL",
            "reason": "manual_sync",
        },
    }
    decoded = decode_job(f"jobs.v1.knowledge_ingest.{TENANT}", json.dumps(envelope).encode())
    assert decoded.job == IngestionJob(
        tenant_id=TENANT, source_id=SOURCE, source_version=3, trace_id=TRACE
    )
    assert (
        decode_job(
            "jobs.v1.knowledge_ingest.0192f0a4-6b1e-7c3d-8e9f-000000000000",
            json.dumps(envelope).encode(),
        ).reason
        == "subject_tenant_mismatch"
    )
    assert (
        decode_job(
            f"jobs.v1.knowledge_ingest.{TENANT}", json.dumps({**envelope, "extra": True}).encode()
        ).job
        is None
    )
    assert decode_job(f"jobs.v1.knowledge_ingest.{TENANT}", b"not json").job is None


@pytest.fixture
async def clamd() -> object:
    received: list[bytes] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        command = await reader.readuntil(b"\0")
        if command == b"zPING\0":
            writer.write(b"PONG\0")
        else:
            data = bytearray()
            while True:
                size = struct.unpack(">I", await reader.readexactly(4))[0]
                if size == 0:
                    break
                data.extend(await reader.readexactly(size))
            received.append(bytes(data))
            writer.write(
                b"stream: Eicar-Test-Signature FOUND\0" if b"EICAR" in data else b"stream: OK\0"
            )
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = int(server.sockets[0].getsockname()[1])
    yield ClamdScanner("127.0.0.1", port), received
    server.close()
    await server.wait_closed()


async def test_clamd_instream_protocol(clamd: tuple[ClamdScanner, list[bytes]]) -> None:
    scanner, received = clamd
    assert await scanner.ping() is True
    large = b"a" * (200 * 1024)
    assert await scanner.scan(large) == ScanResult(verdict="CLEAN", signature=None)
    assert received[0] == large
    assert await scanner.scan(b"X5O!P%@AP EICAR test") == ScanResult(
        verdict="INFECTED", signature="Eicar-Test-Signature"
    )
    assert await ClamdScanner("127.0.0.1", 1, timeout_seconds=1.0).scan(b"x") == ScanResult(
        verdict="ERROR", signature=None
    )


async def test_health_server_reports_readiness() -> None:
    state = {"nats": True, "clamd": False}

    async def readiness() -> dict[str, bool]:
        return dict(state)

    server = HealthServer(
        "127.0.0.1", 0, readiness, lambda: "velyric_document_worker_jobs_processed_total 3\n"
    )
    await server.start()
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{server.port}") as client:
            assert (await client.get("/healthz/live")).json() == {"status": "ok"}
            not_ready = await client.get("/healthz/ready")
            assert not_ready.status_code == 503
            assert not_ready.json() == {
                "status": "unavailable",
                "checks": {"nats": True, "clamd": False},
            }
            state["clamd"] = True
            assert (await client.get("/healthz/ready")).status_code == 200
            assert "jobs_processed_total 3" in (await client.get("/metrics")).text
    finally:
        await server.close()
