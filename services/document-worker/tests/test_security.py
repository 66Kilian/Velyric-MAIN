from __future__ import annotations

import base64
import json

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from velyric_document_worker.config import ConfigError, load_config
from velyric_document_worker.fetcher import FetchError, ObjectDownloader, RemoteFetcher
from velyric_document_worker.service_token import ServiceTokenSigner
from velyric_document_worker.tenant_secrets import SecretUnavailableError, TenantSecretReader

KEY = Ed25519PrivateKey.generate()
PEM = KEY.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode()


def _decode_segment(segment: str) -> dict[str, object]:
    padded = segment + "=" * (-len(segment) % 4)
    value = json.loads(base64.urlsafe_b64decode(padded))
    assert isinstance(value, dict)
    return value


def test_service_token_is_a_verifiable_eddsa_jwt() -> None:
    token = ServiceTokenSigner(PEM, "document-worker-test").sign(
        audience="control-api",
        scopes=("knowledge.ingest",),
        tenant_id="0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f",
        now=1_800_000_000,
    )
    header, claims, signature = token.split(".")
    KEY.public_key().verify(
        base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)),
        f"{header}.{claims}".encode(),
    )
    assert _decode_segment(header) == {"alg": "EdDSA", "typ": "JWT", "kid": "document-worker-test"}
    decoded = _decode_segment(claims)
    assert decoded["iss"] == decoded["sub"] == "document-worker"
    assert decoded["aud"] == "control-api"
    assert decoded["scope"] == "knowledge.ingest"
    assert decoded["exp"] == 1_800_000_120
    assert decoded["tenant_id"] == "0192f0a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f"


def _local_env(**overrides: str) -> dict[str, str]:
    env = {
        "VELYRIC_ENV": "local",
        "VELYRIC_NATS_URL": "nats://127.0.0.1:54222",
        "VELYRIC_CONTROL_API_INTERNAL_URL": "http://127.0.0.1:4001",
        "VELYRIC_SERVICE_SIGNING_KEY_SECRET": PEM,
        "DOCUMENT_WORKER_SERVICE_KEY_ID": "document-worker-local",
        "VELYRIC_PROVIDER_SIMULATOR_URL": "http://127.0.0.1:4010",
        "DOCUMENT_WORKER_CLAMD_HOST": "127.0.0.1",
    }
    env.update(overrides)
    return env


def _no_arn(arn: str) -> str:
    raise AssertionError(arn)


def test_local_configuration_uses_the_simulator() -> None:
    config = load_config(_local_env(), _no_arn)
    assert config.openai_base_url == "http://127.0.0.1:4010/openai/v1"
    assert config.port == 7400
    assert config.nats_creds is None


def test_production_configuration_fails_closed() -> None:
    arn = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:velyric/production/x"
    env = _local_env(
        VELYRIC_ENV="production",
        VELYRIC_NATS_URL="nats://nats.internal:4222",
        VELYRIC_CONTROL_API_INTERNAL_URL="http://control-api.internal:4001",
        DOCUMENT_WORKER_ALLOW_HTTP_FETCH="true",
        DOCUMENT_WORKER_LOCAL_VAULT_DIR="/tmp/vault",  # noqa: S108
    )
    with pytest.raises(ConfigError) as raised:
        load_config(env, lambda _: arn)
    issues = raised.value.issues
    assert "VELYRIC_NATS_URL must use tls:// (nats:// is allowed only in local and ci)" in issues
    assert "VELYRIC_CONTROL_API_INTERNAL_URL must use https outside local and ci" in issues
    assert (
        "VELYRIC_SERVICE_SIGNING_KEY_SECRET is not allowed in production; use VELYRIC_SERVICE_SIGNING_KEY_SECRET_ARN"
        in issues
    )
    assert "DOCUMENT_WORKER_ALLOW_HTTP_FETCH is only allowed in local and ci" in issues
    assert "VELYRIC_PROVIDER_MODE_OPENAI=simulator is not allowed in production" not in issues
    assert all(PEM not in issue for issue in issues)


def test_local_vault_reader_refuses_path_traversal(tmp_path: pytest.TempPathFactory) -> None:
    vault = tmp_path
    target = vault / "tenants" / "t1"  # type: ignore[operator]
    target.mkdir(parents=True)
    (target / "key.secret").write_text("sk-test", encoding="utf-8")
    reader = TenantSecretReader(None, str(vault))
    assert reader.read("local-vault://tenants/t1/key") == "sk-test"
    with pytest.raises(SecretUnavailableError):
        reader.read("local-vault://tenants/../../etc/passwd")
    with pytest.raises(SecretUnavailableError):
        reader.read("aws-sm://tenants/t1/key")


async def _resolver_for(mapping: dict[str, list[str]], host: str) -> list[str]:
    return mapping[host]


def _fetcher(handler: httpx.MockTransport, mapping: dict[str, list[str]]) -> RemoteFetcher:
    async def resolver(host: str, _port: int) -> list[str]:
        return await _resolver_for(mapping, host)

    return RemoteFetcher(httpx.AsyncClient(transport=handler), resolver, allow_http=False)


@pytest.mark.parametrize(
    ("url", "addresses", "code"),
    [
        ("https://intranet.test/wiki", ["10.1.2.3"], "fetch_address_not_public"),
        ("https://metadata.test/latest", ["169.254.169.254"], "fetch_address_not_public"),
        ("https://mixed.test/", ["93.184.216.34", "127.0.0.1"], "fetch_address_not_public"),
        ("https://[::ffff:10.0.0.1]/", [], "fetch_address_not_public"),
        ("http://plain.test/", ["93.184.216.34"], "fetch_scheme_not_allowed"),
        ("https://user:pw@site.test/", ["93.184.216.34"], "fetch_credentials_in_url"),
        ("https://site.test:8443/", ["93.184.216.34"], "fetch_port_not_allowed"),
    ],
)
async def test_remote_fetch_blocks_ssrf_targets(url: str, addresses: list[str], code: str) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError

    host = httpx.URL(url).host
    fetcher = _fetcher(httpx.MockTransport(handler), {host: addresses})
    with pytest.raises(FetchError) as raised:
        await fetcher.fetch(url, 1024)
    assert raised.value.code == code


async def test_remote_fetch_pins_the_validated_address_and_revalidates_redirects() -> None:
    seen: list[tuple[str, str | None, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(
            (str(request.url), request.headers.get("host"), request.extensions.get("sni_hostname"))
        )
        if request.headers.get("host") == "site.test":
            return httpx.Response(302, headers={"location": "https://internal.test/admin"})
        return httpx.Response(200, headers={"content-type": "text/html"}, content=b"<p>secret</p>")

    fetcher = _fetcher(
        httpx.MockTransport(handler),
        {"site.test": ["93.184.216.34"], "internal.test": ["192.168.1.10"]},
    )
    with pytest.raises(FetchError) as raised:
        await fetcher.fetch("https://site.test/arak", 1024)
    assert raised.value.code == "fetch_address_not_public"
    assert seen == [("https://93.184.216.34/arak", "site.test", "site.test")]


async def test_remote_fetch_enforces_type_and_size_limits() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/image":
            return httpx.Response(200, headers={"content-type": "image/png"}, content=b"x")
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"a" * 2048)

    fetcher = _fetcher(httpx.MockTransport(handler), {"site.test": ["93.184.216.34"]})
    with pytest.raises(FetchError) as image:
        await fetcher.fetch("https://site.test/image", 4096)
    assert image.value.code == "fetch_content_type_not_allowed"
    with pytest.raises(FetchError) as large:
        await fetcher.fetch("https://site.test/big", 1024)
    assert large.value.code == "fetch_too_large"
    document = await fetcher.fetch("https://site.test/ok", 4096)
    assert document.final_url == "https://site.test/ok"
    assert len(document.body) == 2048


async def test_object_download_verifies_the_uploaded_checksum() -> None:
    body = b"%PDF-1.7 stored"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "application/pdf"}, content=body)

    downloader = ObjectDownloader(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    import hashlib  # noqa: PLC0415

    digest = hashlib.sha256(body).hexdigest()
    document = await downloader.download(
        "https://bucket.s3.test/key?X-Amz-Signature=1", digest, len(body), 1024
    )
    assert document.sha256 == digest
    with pytest.raises(FetchError) as raised:
        await downloader.download("https://bucket.s3.test/key", "0" * 64, len(body), 1024)
    assert raised.value.code == "object_checksum_mismatch"
