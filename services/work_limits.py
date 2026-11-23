"""Bound running and waiting synchronous work without blocking FastAPI's request pool.

Limits apply per process, across event loops. Only requests admitted before work
starts can receive the explicit capacity response; callers can safely retry that
response without repeating a model/FFmpeg operation. A disconnected or timed-out
waiter releases its place. Once a thread starts, its slot remains occupied until
the underlying work actually finishes, even if its request task is cancelled.
"""
from __future__ import annotations

import asyncio
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
import os
import threading
from typing import Callable, Literal, TypeVar

from fastapi import HTTPException, Request

T = TypeVar("T")
CAPACITY_ERROR_CODE = "SERVICE_CAPACITY_EXHAUSTED"
CAPACITY_RETRY_AFTER_SECONDS = 5
# Do not leave admitted requests waiting until the client's much longer work deadline.
CAPACITY_WAIT_SECONDS = 5.0


def limit_from_env(name: str, default: int = 1) -> int:
    value = os.environ.get(name, str(default))
    try:
        limit = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer between 1 and 32") from exc
    if not 1 <= limit <= 32:
        raise ValueError(f"{name} must be an integer between 1 and 32")
    return limit


def waiting_limit_from_env(name: str, default: int = 4) -> int:
    value = os.environ.get(name, str(default))
    try:
        limit = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer between 0 and 128") from exc
    if not 0 <= limit <= 128:
        raise ValueError(f"{name} must be an integer between 0 and 128")
    return limit


def _capacity_error() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "code": CAPACITY_ERROR_CODE,
            "message": "Service capacity is temporarily unavailable; retry later",
            "retryable": True,
        },
        headers={"Retry-After": str(CAPACITY_RETRY_AFTER_SECONDS)},
    )


@dataclass(eq=False)
class _Ticket:
    loop: asyncio.AbstractEventLoop
    ready: asyncio.Future[None]
    state: Literal["waiting", "running", "released"]


class WorkLimiter:
    def __init__(self, limit: int, name: str, max_waiting: int = 4, wait_seconds: float = CAPACITY_WAIT_SECONDS):
        if not isinstance(limit, int) or not 1 <= limit <= 32:
            raise ValueError("Work limit must be between 1 and 32")
        if not isinstance(max_waiting, int) or not 0 <= max_waiting <= 128:
            raise ValueError("Waiting limit must be between 0 and 128")
        if not 0 < wait_seconds <= 30:
            raise ValueError("Capacity wait must be greater than 0 and at most 30 seconds")
        self.limit = limit
        self.max_waiting = max_waiting
        self.wait_seconds = wait_seconds
        self._executor = ThreadPoolExecutor(max_workers=limit, thread_name_prefix=name)
        self._lock = threading.Lock()
        self._running = 0  # includes granted slots whose threads have not started yet
        self._waiters: deque[_Ticket] = deque()

    def _reserve(self, loop: asyncio.AbstractEventLoop) -> _Ticket:
        # Admission, including reservations about to enter the executor, is process-wide.
        # No separate unbounded executor queue can form when several loops use this limiter.
        with self._lock:
            if self._running < self.limit:
                ticket = _Ticket(loop, loop.create_future(), "running")
                self._running += 1
                ticket.ready.set_result(None)
                return ticket
            if len(self._waiters) >= self.max_waiting:
                raise _capacity_error()
            ticket = _Ticket(loop, loop.create_future(), "waiting")
            self._waiters.append(ticket)
            return ticket

    @staticmethod
    def _wake(ticket: _Ticket) -> None:
        # A disconnect/timeout can race with a cross-thread wakeup.
        if not ticket.ready.done():
            ticket.ready.set_result(None)

    def _release(self, ticket: _Ticket) -> None:
        wake: list[_Ticket] = []
        with self._lock:
            if ticket.state == "released":
                return
            if ticket.state == "waiting":
                self._waiters.remove(ticket)
            else:
                self._running -= 1
            ticket.state = "released"
            while self._running < self.limit and self._waiters:
                next_ticket = self._waiters.popleft()
                next_ticket.state = "running"
                self._running += 1
                wake.append(next_ticket)
        for next_ticket in wake:
            try:
                next_ticket.loop.call_soon_threadsafe(self._wake, next_ticket)
            except RuntimeError:  # a loop closed during shutdown; do not strand its slot
                self._release(next_ticket)

    @staticmethod
    async def _wait_for_disconnect(request: Request) -> None:
        # FastAPI has already read and validated the JSON body before entering
        # the endpoint. Further ASGI messages can include a client disconnect.
        while True:
            message = await request.receive()
            if message["type"] == "http.disconnect":
                return

    async def _acquire(self, request: Request) -> _Ticket:
        ticket = self._reserve(asyncio.get_running_loop())
        disconnect = asyncio.create_task(self._wait_for_disconnect(request))
        try:
            done, _ = await asyncio.wait(
                (ticket.ready, disconnect), timeout=self.wait_seconds, return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect in done:
                await disconnect  # propagate receive errors rather than treating them as disconnects
                raise HTTPException(status_code=499, detail="Client disconnected while waiting for capacity")
            if ticket.ready not in done:
                raise _capacity_error()
            await ticket.ready
            # Prefer a disconnect that raced with acquiring the slot.
            disconnect.cancel()
            await asyncio.gather(disconnect, return_exceptions=True)
            if not disconnect.cancelled():
                await disconnect
                raise HTTPException(status_code=499, detail="Client disconnected while waiting for capacity")
        except BaseException:
            self._release(ticket)
            if not ticket.ready.done():
                ticket.ready.cancel()
            disconnect.cancel()
            disconnect.add_done_callback(lambda task: None if task.cancelled() else task.exception())
            raise
        return ticket

    async def run(self, request: Request, work: Callable[..., T], *args: object) -> T:
        ticket = await self._acquire(request)
        try:
            future = self._executor.submit(partial(work, *args))
        except BaseException:
            self._release(ticket)
            raise

        # Cancellation of the request cannot stop a running synchronous thread.
        # Release only when that thread actually finishes (or its future is cancelled before start).
        future.add_done_callback(lambda _future: self._release(ticket))
        return await asyncio.wrap_future(future)

    def close(self) -> None:
        """Stop accepting new work; running synchronous calls finish normally."""
        self._executor.shutdown(wait=False, cancel_futures=True)
