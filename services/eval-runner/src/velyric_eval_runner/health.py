from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from http import HTTPStatus

ReadinessCheck = Callable[[], Awaitable[dict[str, bool]]]
MetricsRender = Callable[[], str]

CRLF = "\r\n"
REQUEST_LINE_PARTS = 2


def _response(status: int, content_type: str, payload: bytes) -> bytes:
    head = CRLF.join(
        [
            f"HTTP/1.1 {status} {HTTPStatus(status).phrase}",
            f"content-type: {content_type}",
            f"content-length: {len(payload)}",
            "connection: close",
            "",
            "",
        ]
    )
    return head.encode("latin-1") + payload


class HealthServer:
    def __init__(
        self, host: str, port: int, readiness: ReadinessCheck, metrics: MetricsRender
    ) -> None:
        self._host = host
        self._port = port
        self._readiness = readiness
        self._metrics = metrics
        self._server: asyncio.Server | None = None

    @property
    def port(self) -> int:
        if self._server is None or not self._server.sockets:
            return self._port
        return int(self._server.sockets[0].getsockname()[1])

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, self._host, self._port)

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            while (await asyncio.wait_for(reader.readline(), timeout=5.0)).strip():
                pass
            parts = request_line.decode("latin-1").split()
            method, path = (parts[0], parts[1]) if len(parts) >= REQUEST_LINE_PARTS else ("", "")
            status, body, content_type = await self._route(method, path)
            writer.write(_response(status, content_type, body.encode("utf-8")))
            await writer.drain()
        except (TimeoutError, ConnectionError):
            pass
        finally:
            writer.close()

    async def _route(self, method: str, path: str) -> tuple[int, str, str]:
        if method != "GET":
            return (
                HTTPStatus.METHOD_NOT_ALLOWED,
                json.dumps({"code": "METHOD_NOT_ALLOWED"}),
                "application/json",
            )
        if path == "/healthz/live":
            return HTTPStatus.OK, json.dumps({"status": "ok"}), "application/json"
        if path == "/healthz/ready":
            checks = await self._readiness()
            ready = all(checks.values())
            status = HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE
            body = json.dumps({"status": "ready" if ready else "unavailable", "checks": checks})
            return status, body, "application/json"
        if path == "/metrics":
            return HTTPStatus.OK, self._metrics(), "text/plain; version=0.0.4"
        return HTTPStatus.NOT_FOUND, json.dumps({"code": "NOT_FOUND"}), "application/json"
