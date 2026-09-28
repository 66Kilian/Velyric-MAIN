from __future__ import annotations

import asyncio
import contextlib
import secrets
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, ClassVar, Literal, Protocol

import structlog
from nats.errors import TimeoutError as NatsTimeoutError
from nats.js.api import (
    AckPolicy,
    ConsumerConfig,
    DeliverPolicy,
    RetentionPolicy,
    StorageType,
    StreamConfig,
)
from nats.js.errors import NotFoundError
from pydantic import ConfigDict, Field, TypeAdapter, ValidationError

from velyric_eval_runner.runner import JobResult, SimulationJob

if TYPE_CHECKING:
    from nats.aio.msg import Msg
    from nats.js import JetStreamContext

JOBS_STREAM = "JOBS"
DEAD_LETTER_STREAM = "DEAD_LETTER"
CONSUMER_NAME = "eval-simulation-run"
FILTER_SUBJECT = "jobs.v1.simulation_run.>"
MAX_DELIVER = 5
ACK_WAIT_SECONDS = 900.0
_UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

log = structlog.get_logger("velyric.eval_runner.consumer")


@dataclass(frozen=True)
class _Payload:
    __pydantic_config__: ClassVar[ConfigDict] = ConfigDict(extra="ignore")
    run_id: Annotated[str, Field(pattern=_UUID)]


@dataclass(frozen=True)
class _Envelope:
    __pydantic_config__: ClassVar[ConfigDict] = ConfigDict(extra="forbid")
    schema_version: Annotated[int, Field(ge=1)]
    event_id: Annotated[str, Field(pattern=_UUID)]
    event_type: Literal["simulation.run_requested"]
    tenant_id: Annotated[str, Field(pattern=_UUID)]
    trace_id: Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]
    occurred_at: str
    producer: str
    payload: _Payload


_envelope_adapter: TypeAdapter[_Envelope] = TypeAdapter(_Envelope)


class JobRunner(Protocol):
    async def run(self, job: SimulationJob, *, final_attempt: bool) -> JobResult: ...


@dataclass(frozen=True)
class Decoded:
    job: SimulationJob | None
    reason: str | None


def decode_job(subject: str, data: bytes) -> Decoded:
    try:
        envelope = _envelope_adapter.validate_json(data)
    except ValidationError as error:
        return Decoded(job=None, reason=f"invalid_envelope:{error.error_count()}")
    if subject != f"jobs.v1.simulation_run.{envelope.tenant_id}":
        return Decoded(job=None, reason="subject_tenant_mismatch")
    return Decoded(
        job=SimulationJob(
            tenant_id=envelope.tenant_id,
            run_id=envelope.payload.run_id,
            trace_id=envelope.trace_id,
        ),
        reason=None,
    )


async def ensure_topology(js: JetStreamContext, replicas: int) -> None:
    for name, subjects, retention, max_age in (
        (JOBS_STREAM, ["jobs.v1.>"], RetentionPolicy.WORK_QUEUE, 3 * 86400.0),
        (DEAD_LETTER_STREAM, ["dlq.v1.>"], RetentionPolicy.LIMITS, 30 * 86400.0),
    ):
        try:
            await js.stream_info(name)
        except NotFoundError:
            await js.add_stream(
                StreamConfig(
                    name=name,
                    subjects=subjects,
                    retention=retention,
                    storage=StorageType.FILE,
                    max_age=max_age,
                    num_replicas=replicas,
                    duplicate_window=120.0,
                ),
            )


class SimulationJobConsumer:
    def __init__(self, js: JetStreamContext, runner: JobRunner, *, concurrency: int) -> None:
        self._js = js
        self._runner = runner
        self._concurrency = concurrency
        self._stopping = asyncio.Event()
        self._active: set[asyncio.Task[None]] = set()
        self.last_fetch_ok = False
        self.processed = 0
        self.failed = 0

    async def run(self) -> None:
        subscription = await self._js.pull_subscribe(
            FILTER_SUBJECT,
            durable=CONSUMER_NAME,
            stream=JOBS_STREAM,
            config=ConsumerConfig(
                durable_name=CONSUMER_NAME,
                ack_policy=AckPolicy.EXPLICIT,
                deliver_policy=DeliverPolicy.ALL,
                ack_wait=ACK_WAIT_SECONDS,
                max_deliver=MAX_DELIVER,
                filter_subject=FILTER_SUBJECT,
                max_ack_pending=self._concurrency * 4,
            ),
        )
        while not self._stopping.is_set():
            capacity = self._concurrency - len(self._active)
            if capacity <= 0:
                await asyncio.wait(self._active, return_when=asyncio.FIRST_COMPLETED)
                continue
            try:
                messages = await subscription.fetch(capacity, timeout=5.0)
                self.last_fetch_ok = True
            except NatsTimeoutError:
                self.last_fetch_ok = True
                continue
            except Exception:
                self.last_fetch_ok = False
                log.exception("simulation job fetch failed")
                await asyncio.sleep(2.0)
                continue
            for message in messages:
                task = asyncio.create_task(self._handle(message))
                self._active.add(task)
                task.add_done_callback(self._active.discard)
        if self._active:
            await asyncio.wait(self._active, timeout=ACK_WAIT_SECONDS / 2)
        with contextlib.suppress(Exception):
            await subscription.unsubscribe()

    def stop(self) -> None:
        self._stopping.set()

    async def _handle(self, message: Msg) -> None:
        delivered = message.metadata.num_delivered
        decoded = decode_job(message.subject, message.data)
        if decoded.job is None:
            await self._dead_letter(message, decoded.reason or "invalid")
            return
        heartbeat = asyncio.create_task(self._keep_alive(message))
        try:
            result = await self._runner.run(decoded.job, final_attempt=delivered >= MAX_DELIVER)
        except Exception:
            log.exception("simulation job crashed", run_id=decoded.job.run_id)
            result = JobResult(disposition="RETRY", outcome="CRASHED", retry_after_seconds=60.0)
        finally:
            heartbeat.cancel()
        if result.disposition == "ACK":
            self.processed += 1
            await message.ack()
            return
        self.failed += 1
        if delivered >= MAX_DELIVER:
            await self._dead_letter(message, f"retries_exhausted:{result.outcome}")
            return
        await message.nak(
            delay=min(900.0, result.retry_after_seconds * (2 ** max(0, delivered - 1)))
        )

    async def _keep_alive(self, message: Msg) -> None:
        while True:
            await asyncio.sleep(ACK_WAIT_SECONDS / 3)
            with contextlib.suppress(Exception):
                await message.in_progress()

    async def _dead_letter(self, message: Msg, reason: str) -> None:
        sequence = message.metadata.sequence.stream
        headers = {
            "Nats-Msg-Id": f"{JOBS_STREAM}:{CONSUMER_NAME}:{sequence}",
            "Velyric-Original-Subject": message.subject,
            "Velyric-Dead-Letter-Reason": reason[:200],
            "traceparent": f"00-{secrets.token_hex(16)}-{secrets.token_hex(8)}-01",
        }
        try:
            await self._js.publish(
                f"dlq.v1.{JOBS_STREAM}.{CONSUMER_NAME}", message.data, headers=headers
            )
            await message.term()
            log.error(
                "simulation job moved to the dead letter stream",
                subject=message.subject,
                reason=reason,
            )
        except Exception:
            log.exception("dead letter publish failed", subject=message.subject)
            await message.nak(delay=30.0)
