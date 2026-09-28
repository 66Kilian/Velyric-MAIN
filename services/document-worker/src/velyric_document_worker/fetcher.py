from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from http import HTTPStatus
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

Resolver = Callable[[str, int], Awaitable[list[str]]]

MAX_REDIRECTS = 3
ALLOWED_REMOTE_TYPES = (
    "text/html",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/pdf",
    "application/xhtml+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
)


class FetchError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class FetchedDocument:
    body: bytes
    content_type: str
    sha256: str
    final_url: str


async def system_resolver(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({str(info[4][0]) for info in infos})


def _is_public(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return bool(ip.is_global) and not ip.is_multicast


class RemoteFetcher:
    def __init__(
        self,
        client: httpx.AsyncClient,
        resolver: Resolver,
        *,
        allow_http: bool,
        timeout_seconds: float = 20.0,
    ) -> None:
        self._client = client
        self._resolver = resolver
        self._allow_http = allow_http
        self._timeout = timeout_seconds

    async def _pin(self, url: str) -> tuple[str, str, str]:
        parts = urlsplit(url)
        if parts.scheme not in ("https", "http") or (
            parts.scheme == "http" and not self._allow_http
        ):
            raise FetchError(
                "fetch_scheme_not_allowed", "only https URLs may be fetched", retryable=False
            )
        if parts.username or parts.password:
            raise FetchError(
                "fetch_credentials_in_url", "URLs must not embed credentials", retryable=False
            )
        host = parts.hostname
        if host is None:
            raise FetchError("fetch_invalid_url", "URL has no host", retryable=False)
        default_port = 443 if parts.scheme == "https" else 80
        port = parts.port or default_port
        if port != default_port:
            raise FetchError(
                "fetch_port_not_allowed", "only default ports may be fetched", retryable=False
            )
        try:
            literal = ipaddress.ip_address(host)
            addresses = [str(literal)]
        except ValueError:
            try:
                addresses = await self._resolver(host, port)
            except OSError as error:
                raise FetchError(
                    "fetch_dns_failed", f"could not resolve {host}", retryable=True
                ) from error
        if not addresses:
            raise FetchError("fetch_dns_failed", f"no addresses for {host}", retryable=True)
        if not all(_is_public(address) for address in addresses):
            raise FetchError(
                "fetch_address_not_public",
                "the URL resolves to a non-public address",
                retryable=False,
            )
        target = addresses[0]
        netloc = f"[{target}]" if ":" in target else target
        pinned = urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
        return pinned, host, url

    async def fetch(self, url: str, max_bytes: int) -> FetchedDocument:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            pinned, host, original = await self._pin(current)
            request = self._client.build_request(
                "GET",
                pinned,
                headers={
                    "host": host,
                    "accept": ", ".join(ALLOWED_REMOTE_TYPES),
                    "user-agent": "VelyricKnowledgeFetcher/1.0",
                },
                extensions={
                    "sni_hostname": host,
                    "timeout": {"connect": 5.0, "read": self._timeout, "write": 5.0, "pool": 5.0},
                },
            )
            try:
                response = await self._client.send(request, stream=True, follow_redirects=False)
            except httpx.TimeoutException as error:
                raise FetchError(
                    "fetch_timeout", "the remote server timed out", retryable=True
                ) from error
            except httpx.HTTPError as error:
                raise FetchError(
                    "fetch_connection_failed",
                    f"connection failed: {type(error).__name__}",
                    retryable=True,
                ) from error
            try:
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get("location")
                    if not location:
                        raise FetchError(
                            "fetch_redirect_invalid", "redirect without location", retryable=False
                        )
                    current = urljoin(original, location)
                    continue
                if response.is_server_error or response.status_code == HTTPStatus.TOO_MANY_REQUESTS:
                    raise FetchError(
                        f"fetch_http_{response.status_code}",
                        "remote server unavailable",
                        retryable=True,
                    )
                if response.status_code != HTTPStatus.OK:
                    raise FetchError(
                        f"fetch_http_{response.status_code}",
                        "remote server refused the request",
                        retryable=False,
                    )
                content_type = (
                    response.headers.get("content-type", "").split(";")[0].strip().lower()
                )
                if content_type not in ALLOWED_REMOTE_TYPES:
                    raise FetchError(
                        "fetch_content_type_not_allowed",
                        f"content type {content_type or 'unknown'} is not supported",
                        retryable=False,
                    )
                declared = response.headers.get("content-length")
                if declared is not None and declared.isdigit() and int(declared) > max_bytes:
                    raise FetchError(
                        "fetch_too_large", "document exceeds the size limit", retryable=False
                    )
                buffer = bytearray()
                async for piece in response.aiter_bytes():
                    buffer.extend(piece)
                    if len(buffer) > max_bytes:
                        raise FetchError(
                            "fetch_too_large", "document exceeds the size limit", retryable=False
                        )
                body = bytes(buffer)
                return FetchedDocument(
                    body=body,
                    content_type=content_type,
                    sha256=hashlib.sha256(body).hexdigest(),
                    final_url=original,
                )
            finally:
                await response.aclose()
        raise FetchError("fetch_too_many_redirects", "too many redirects", retryable=False)


class ObjectDownloader:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    async def download(
        self, url: str, expected_sha256: str | None, expected_size: int | None, max_bytes: int
    ) -> FetchedDocument:
        try:
            async with self._client.stream("GET", url, timeout=60.0) as response:
                if response.status_code in (HTTPStatus.FORBIDDEN, HTTPStatus.NOT_FOUND):
                    raise FetchError(
                        "object_unavailable",
                        f"object download returned {response.status_code}",
                        retryable=response.status_code == HTTPStatus.FORBIDDEN,
                    )
                if response.status_code != HTTPStatus.OK:
                    raise FetchError(
                        f"object_http_{response.status_code}",
                        "object storage unavailable",
                        retryable=True,
                    )
                buffer = bytearray()
                async for piece in response.aiter_bytes():
                    buffer.extend(piece)
                    if len(buffer) > max_bytes:
                        raise FetchError(
                            "object_too_large", "object exceeds the size limit", retryable=False
                        )
                content_type = (
                    response.headers.get("content-type", "application/octet-stream")
                    .split(";")[0]
                    .strip()
                    .lower()
                )
        except httpx.HTTPError as error:
            raise FetchError(
                "object_connection_failed",
                f"object download failed: {type(error).__name__}",
                retryable=True,
            ) from error
        body = bytes(buffer)
        digest = hashlib.sha256(body).hexdigest()
        if expected_size is not None and len(body) != expected_size:
            raise FetchError(
                "object_size_mismatch", "object size does not match the upload", retryable=False
            )
        if expected_sha256 is not None and digest != expected_sha256:
            raise FetchError(
                "object_checksum_mismatch",
                "object checksum does not match the upload",
                retryable=False,
            )
        return FetchedDocument(
            body=body,
            content_type=content_type,
            sha256=digest,
            final_url=url.split("?", maxsplit=1)[0],
        )
