from __future__ import annotations

import asyncio
import struct
from dataclasses import dataclass
from typing import Literal, Protocol

CHUNK_SIZE = 64 * 1024


@dataclass(frozen=True)
class ScanResult:
    verdict: Literal["CLEAN", "INFECTED", "ERROR"]
    signature: str | None


class MalwareScanner(Protocol):
    async def scan(self, body: bytes) -> ScanResult: ...


class ClamdScanner:
    def __init__(self, host: str, port: int, *, timeout_seconds: float = 60.0) -> None:
        self._host = host
        self._port = port
        self._timeout = timeout_seconds

    async def ping(self) -> bool:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self._host, self._port), timeout=3.0
            )
        except (OSError, TimeoutError):
            return False
        try:
            writer.write(b"zPING\0")
            await writer.drain()
            reply = await asyncio.wait_for(reader.readuntil(b"\0"), timeout=3.0)
            return reply.rstrip(b"\0") == b"PONG"
        except (OSError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            return False
        finally:
            writer.close()

    async def scan(self, body: bytes) -> ScanResult:
        try:
            return await asyncio.wait_for(self._scan(body), timeout=self._timeout)
        except (OSError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            return ScanResult(verdict="ERROR", signature=None)

    async def _scan(self, body: bytes) -> ScanResult:
        reader, writer = await asyncio.open_connection(self._host, self._port)
        try:
            writer.write(b"zINSTREAM\0")
            for offset in range(0, len(body), CHUNK_SIZE):
                piece = body[offset : offset + CHUNK_SIZE]
                writer.write(struct.pack(">I", len(piece)) + piece)
                await writer.drain()
            writer.write(struct.pack(">I", 0))
            await writer.drain()
            reply = (
                (await reader.readuntil(b"\0"))
                .rstrip(b"\0")
                .decode("utf-8", errors="replace")
                .strip()
            )
        finally:
            writer.close()
        if reply.endswith(": OK"):
            return ScanResult(verdict="CLEAN", signature=None)
        if reply.endswith(" FOUND"):
            signature = reply.removeprefix("stream: ").removesuffix(" FOUND").strip()
            return ScanResult(verdict="INFECTED", signature=signature[:200] or None)
        return ScanResult(verdict="ERROR", signature=None)
