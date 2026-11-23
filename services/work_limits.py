"""Bound expensive synchronous service work without tying up FastAPI's request pool.

The limit applies per process. Requests wait asynchronously rather than receiving
an overload error that would consume the pipeline's retry budget. A disconnected
client is removed while it is still waiting. Once work starts it cannot generally
be cancelled (e.g. FFmpeg or a Whisper inference); its slot remains occupied until
the underlying thread actually finishes, even if the request task is cancelled.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import os
import threading
from typing import Callable, TypeVar
from weakref import WeakKeyDictionary

from fastapi import HTTPException, Request

T = TypeVar("T")


def limit_from_env(name: str, default: int = 1) -> int:
    value = os.environ.get(name, str(default))
    try:
        limit = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer between 1 and 32") from exc
    if not 1 <= limit <= 32:
        raise ValueError(f"{name} must be an integer between 1 and 32")
    return limit


class WorkLimiter:
    def __init__(self, limit: int, name: str):
        if not 1 <= limit <= 32:
            raise ValueError("Work limit must be between 1 and 32")
        self.limit = limit
        self._executor = ThreadPoolExecutor(max_workers=limit, thread_name_prefix=name)
        # A Uvicorn worker normally has one loop. Separate loop-bound semaphores
        # also make the limiter safe to exercise in isolated-loop tests; the
        # executor itself still enforces the per-process ceiling across loops.
        self._semaphores: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = WeakKeyDictionary()
        self._registry_lock = threading.Lock()

    def _semaphore(self, loop: asyncio.AbstractEventLoop) -> asyncio.Semaphore:
        with self._registry_lock:
            semaphore = self._semaphores.get(loop)
            if semaphore is None:
                semaphore = asyncio.Semaphore(self.limit)
                self._semaphores[loop] = semaphore
            return semaphore

    @staticmethod
    async def _wait_for_disconnect(request: Request) -> None:
        # FastAPI has already read and validated the JSON body before entering
        # the endpoint. Further ASGI messages can include a client disconnect.
        while True:
            message = await request.receive()
            if message["type"] == "http.disconnect":
                return

    async def _acquire(self, request: Request) -> asyncio.Semaphore:
        semaphore = self._semaphore(asyncio.get_running_loop())
        waiting = asyncio.create_task(semaphore.acquire())
        disconnect = asyncio.create_task(self._wait_for_disconnect(request))
        try:
            done, _ = await asyncio.wait((waiting, disconnect), return_when=asyncio.FIRST_COMPLETED)
            if disconnect in done:
                await disconnect  # propagate receive errors rather than treating them as disconnects
                raise HTTPException(status_code=499, detail="Client disconnected while waiting for capacity")
            await waiting
            # Prefer a disconnect that raced with acquiring the slot.
            disconnect.cancel()
            await asyncio.gather(disconnect, return_exceptions=True)
            if not disconnect.cancelled():
                await disconnect
                raise HTTPException(status_code=499, detail="Client disconnected while waiting for capacity")
        except BaseException:
            disconnect.cancel()
            waiting.cancel()

            def release_if_acquired(task: asyncio.Task) -> None:
                if not task.cancelled() and task.exception() is None and task.result():
                    semaphore.release()

            # A cancelled acquire may have won the slot at the same instant.
            # Its callback releases that slot even if this request is cancelled again.
            waiting.add_done_callback(release_if_acquired)
            disconnect.add_done_callback(lambda task: None if task.cancelled() else task.exception())
            raise
        return semaphore

    async def run(self, request: Request, work: Callable[..., T], *args: object) -> T:
        semaphore = await self._acquire(request)
        loop = asyncio.get_running_loop()
        try:
            future = self._executor.submit(partial(work, *args))
        except BaseException:
            semaphore.release()
            raise

        def release_when_finished(_future: object) -> None:
            # The asyncio request can be cancelled while a synchronous thread is
            # still running. Release on *thread completion*, not request exit.
            try:
                loop.call_soon_threadsafe(semaphore.release)
            except RuntimeError:  # loop is already closed during process shutdown
                pass

        future.add_done_callback(release_when_finished)
        return await asyncio.wrap_future(future)

    def close(self) -> None:
        """Stop accepting new work; running synchronous calls finish normally."""
        self._executor.shutdown(wait=False, cancel_futures=True)
