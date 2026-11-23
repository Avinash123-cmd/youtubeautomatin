"""Capacity remains reserved for running work, even if callers disappear."""
import asyncio
import importlib
import os
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

from services.work_limits import WorkLimiter, limit_from_env


class FakeRequest:
    def __init__(self):
        self.messages = asyncio.Queue()

    async def receive(self):
        return await self.messages.get()


class WorkLimiterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.limiter = WorkLimiter(1, 'test-limiter')
        self.release = threading.Event()
        self.started = threading.Event()
        self.second_started = threading.Event()
        self.tasks = []

    async def asyncTearDown(self):
        self.release.set()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        self.limiter.close()

    def first(self):
        self.started.set()
        if not self.release.wait(10):
            raise RuntimeError('test did not release work')
        return 'first'

    def second(self):
        self.second_started.set()
        return 'second'

    async def start_first(self):
        first = asyncio.create_task(self.limiter.run(FakeRequest(), self.first))
        self.tasks.append(first)
        self.assertTrue(await asyncio.to_thread(self.started.wait, 3))
        return first

    async def test_disconnect_while_waiting_never_starts_work(self):
        first = await self.start_first()
        request = FakeRequest()
        second = asyncio.create_task(self.limiter.run(request, self.second))
        self.tasks.append(second)
        await asyncio.sleep(0.05)
        await request.messages.put({'type': 'http.disconnect'})
        with self.assertRaises(HTTPException) as caught:
            await asyncio.wait_for(second, 2)
        self.assertEqual(caught.exception.status_code, 499)
        self.release.set()
        self.assertEqual(await first, 'first')
        await asyncio.sleep(0.05)
        self.assertFalse(self.second_started.is_set())
        self.assertEqual(await self.limiter.run(FakeRequest(), self.second), 'second')

    async def test_cancelled_waiter_does_not_leak_a_slot(self):
        first = await self.start_first()
        waiting = asyncio.create_task(self.limiter.run(FakeRequest(), self.second))
        self.tasks.append(waiting)
        await asyncio.sleep(0.05)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.release.set()
        self.assertEqual(await first, 'first')
        self.assertEqual(await asyncio.wait_for(self.limiter.run(FakeRequest(), self.second), 2), 'second')

    async def test_cancelling_running_request_does_not_release_slot_early(self):
        first = await self.start_first()
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        second = asyncio.create_task(self.limiter.run(FakeRequest(), self.second))
        self.tasks.append(second)
        await asyncio.sleep(0.1)
        self.assertFalse(self.second_started.is_set())
        self.release.set()
        self.assertEqual(await asyncio.wait_for(second, 2), 'second')

    async def test_simultaneous_disconnect_and_slot_is_released(self):
        request = FakeRequest()
        request.messages.put_nowait({'type': 'http.disconnect'})
        with self.assertRaises(HTTPException):
            await self.limiter.run(request, self.second)
        self.assertFalse(self.second_started.is_set())
        self.assertEqual(await asyncio.wait_for(self.limiter.run(FakeRequest(), self.second), 2), 'second')

    async def test_failed_work_releases_slot(self):
        def fail():
            raise RuntimeError('work failed')
        with self.assertRaisesRegex(RuntimeError, 'work failed'):
            await self.limiter.run(FakeRequest(), fail)
        self.assertEqual(await asyncio.wait_for(self.limiter.run(FakeRequest(), self.second), 2), 'second')


class WorkConfigurationTests(unittest.TestCase):
    def test_limits_reject_invalid_values(self):
        for value in ('0', '-1', '33', '1.5', 'invalid', ''):
            with self.subTest(value=value), mock.patch.dict(os.environ, {'TEST_WORK_LIMIT': value}):
                with self.assertRaises(ValueError):
                    limit_from_env('TEST_WORK_LIMIT')
        with mock.patch.dict(os.environ, {'TEST_WORK_LIMIT': '2'}):
            self.assertEqual(limit_from_env('TEST_WORK_LIMIT'), 2)

    def test_concurrent_model_load_happens_only_once(self):
        module = importlib.import_module('services.ai-engine.app.transcribe')
        settings = SimpleNamespace(whisper_model='test-model', whisper_device='cpu', whisper_compute_type='int8')
        loads = []
        release = threading.Event()
        started = threading.Event()
        model = object()

        def load(*_args, **_kwargs):
            loads.append(1)
            started.set()
            if not release.wait(3):
                raise RuntimeError('test did not release model loader')
            return model

        module._model_cache.clear()
        try:
            with mock.patch.dict(sys.modules, {'faster_whisper': SimpleNamespace(WhisperModel=load)}), ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(module._load_model, settings) for _ in range(4)]
                self.assertTrue(started.wait(2))
                release.set()
                self.assertTrue(all(future.result(timeout=3) is model for future in futures))
            self.assertEqual(len(loads), 1)
        finally:
            release.set()
            module._model_cache.clear()


if __name__ == '__main__':
    unittest.main()
