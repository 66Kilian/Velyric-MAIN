from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from velyric_document_worker.control_api import ControlApiClient
from velyric_document_worker.fetcher import FetchedDocument, FetchError
from velyric_document_worker.pipeline import IngestionJob, IngestionPipeline
from velyric_document_worker.scanner import ScanResult
from velyric_document_worker.service_token import ServiceTokenSigner

TENANT = "0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f"
SOURCE = "0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e70"
TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
PEM = (
    Ed25519PrivateKey.generate()
    .private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    .decode()
)
SEED_URL = "https://hubertus.test/"

SEED_HTML = b"""<html><head>
    <script type="application/ld+json">
    {"@type": "Restaurant", "name": "Hubertus", "telephone": "+36301234567",
     "address": {"streetAddress": "Fo utca 1", "addressLocality": "Sopron", "postalCode": "9400"},
     "openingHoursSpecification": [{"dayOfWeek": "Monday", "opens": "07:00", "closes": "22:00"}]}
    </script>
    </head><body>
    <h1>Kezdolap</h1><p>Udvozlunk a Hubertusban.</p>
    <a href="/rolunk">Rolunk</a>
    </body></html>"""
SUBPAGE_HTML = (
    b"<html><body><h1>Rolunk</h1><p>1998 ota varunk mindenkit teraszunkon.</p></body></html>"
)


@dataclass
class FakeControlApi:
    versions: list[dict[str, object]] = field(default_factory=list)
    chunks: list[dict[str, object]] = field(default_factory=list)
    completed: list[dict[str, object]] = field(default_factory=list)

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path == f"/internal/v1/knowledge/ingestions/{SOURCE}":
            return httpx.Response(
                200,
                json={
                    "source": {
                        "id": SOURCE,
                        "tenant_id": TENANT,
                        "source_type": "URL",
                        "source_version": 1,
                        "title": "Weboldal",
                        "mime_type": None,
                        "language": None,
                        "location_id": None,
                    },
                    "fetch": {"kind": "URL", "uri": SEED_URL, "max_bytes": 5_000_000},
                    "active_content_sha256": None,
                    "embedding": {
                        "model": "text-embedding-3-small",
                        "dimensions": 2,
                        "required": False,
                        "api_key": None,
                    },
                    "limits": {
                        "max_chunks": 4000,
                        "max_chunks_per_batch": 100,
                        "max_chunk_chars": 16000,
                    },
                },
            )
        body = json.loads(request.content) if request.content else {}
        if path.endswith("/versions"):
            self.versions.append(body)
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
                    "embeddings_stored": False,
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
        return httpx.Response(404, json={"code": "NOT_FOUND"})


class FakeRemote:
    def __init__(self, pages: dict[str, FetchedDocument]) -> None:
        self.pages = pages
        self.requested: list[str] = []

    async def fetch(self, url: str, max_bytes: int) -> FetchedDocument:
        self.requested.append(url)
        assert max_bytes > 0
        if url not in self.pages:
            raise FetchError("fetch_http_404", "not found", retryable=False)
        return self.pages[url]


class FakeObjects:
    async def download(
        self, url: str, expected_sha256: str | None, expected_size: int | None, max_bytes: int
    ) -> FetchedDocument:
        raise AssertionError((url, expected_sha256, expected_size, max_bytes))


class FakeScanner:
    async def scan(self, body: bytes) -> ScanResult:
        assert body
        return ScanResult(verdict="CLEAN", signature=None)


class FakeEmbedder:
    async def embed(
        self, api_key: str, model: str, dimensions: int, texts: list[str]
    ) -> list[tuple[float, ...]]:
        raise AssertionError((api_key, model, dimensions, texts))


class FakeSecrets:
    def read(self, reference: str) -> str:
        raise AssertionError(reference)


def _doc(body: bytes, final_url: str) -> FetchedDocument:
    return FetchedDocument(
        body=body,
        content_type="text/html",
        sha256=hashlib.sha256(body).hexdigest(),
        final_url=final_url,
    )


async def test_website_source_crawls_linked_pages_and_extracts_structured_facts() -> None:
    api = FakeControlApi()
    remote = FakeRemote(
        {
            SEED_URL: _doc(SEED_HTML, SEED_URL),
            "https://hubertus.test/rolunk": _doc(SUBPAGE_HTML, "https://hubertus.test/rolunk"),
        }
    )
    client = ControlApiClient(
        "http://control-api.test",
        ServiceTokenSigner(PEM, "document-worker-test"),
        httpx.AsyncClient(transport=httpx.MockTransport(api.handler)),
    )
    pipeline = IngestionPipeline(
        control_api=client,
        remote=remote,
        objects=FakeObjects(),
        scanner=FakeScanner(),
        embedder=FakeEmbedder(),
        secrets=FakeSecrets(),
        ocr_enabled=False,
    )
    job = IngestionJob(tenant_id=TENANT, source_id=SOURCE, source_version=1, trace_id=TRACE)
    result = await pipeline.run(job, final_attempt=False)
    assert (result.disposition, result.outcome) == ("ACK", "ACTIVATED")

    chunk_texts = [chunk["content"] for chunk in api.chunks]
    assert any("Hubertus" in text and "+36301234567" in text for text in chunk_texts), chunk_texts
    assert any("teraszunkon" in text for text in chunk_texts), chunk_texts
    assert "https://hubertus.test/rolunk" in remote.requested
    assert api.chunks[0]["heading_path"] == ["Structured business data"]
    assert api.completed == [
        {
            "chunk_count": len(api.chunks),
            "extracted_location_facts": {
                "address": {"line1": "Fo utca 1", "city": "Sopron", "postal_code": "9400"},
                "business_hours": [{"iso_weekday": 1, "opens": "07:00", "closes": "22:00"}],
            },
        }
    ]
