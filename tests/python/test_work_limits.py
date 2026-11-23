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

from services.work_limits import CAPACITY_ERROR_CODE, WorkLimiter, limit_from_env, waiting_limit_from_env


class FakeRequest:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.listening = asyncio.Event()

    async def receive(self):
        self.listening.set()
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

    async def test_full_queue_refuses_before_starting_any_work(self):
        self.limiter.close()
        self.limiter = WorkLimiter(1, 'bounded', max_waiting=1, wait_seconds=2)
        first = await self.start_first()
        request = FakeRequest()
        queued = asyncio.create_task(self.limiter.run(request, self.second))
        self.tasks.append(queued)
        await asyncio.wait_for(request.listening.wait(), 1)
        with self.assertRaises(HTTPException) as caught:
            await self.limiter.run(FakeRequest(), self.second)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail['code'], CAPACITY_ERROR_CODE)
        self.assertTrue(caught.exception.detail['retryable'])
        self.assertEqual(caught.exception.headers['Retry-After'], '5')
        self.assertFalse(self.second_started.is_set())
        self.release.set()
        self.assertEqual(await first, 'first')
        self.assertEqual(await queued, 'second')

    async def test_wait_deadline_refuses_before_work_and_frees_queue_position(self):
        self.limiter.close()
        self.limiter = WorkLimiter(1, 'deadline', max_waiting=1, wait_seconds=0.3)
        first = await self.start_first()
        with self.assertRaises(HTTPException) as caught:
            await self.limiter.run(FakeRequest(), self.second)
        self.assertEqual(caught.exception.detail['code'], CAPACITY_ERROR_CODE)
        self.assertFalse(self.second_started.is_set())
        request = FakeRequest()
        queued = asyncio.create_task(self.limiter.run(request, self.second))
        self.tasks.append(queued)
        await asyncio.wait_for(request.listening.wait(), 1)  # not rejected as full
        self.release.set()
        self.assertEqual(await first, 'first')
        self.assertEqual(await asyncio.wait_for(queued, 2), 'second')

    async def test_no_waiters_mode_and_cancelled_running_work(self):
        self.limiter.close()
        self.limiter = WorkLimiter(1, 'no-wait', max_waiting=0)
        first = await self.start_first()
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        with self.assertRaises(HTTPException) as caught:
            await self.limiter.run(FakeRequest(), self.second)
        self.assertEqual(caught.exception.detail['code'], CAPACITY_ERROR_CODE)
        self.assertFalse(self.second_started.is_set())
        self.release.set()
        # The thread, not the cancelled request, controls release of the slot.
        await asyncio.to_thread(self.started.wait, 1)
        for _ in range(100):
            try:
                self.assertEqual(await self.limiter.run(FakeRequest(), self.second), 'second')
                break
            except HTTPException:
                await asyncio.sleep(0.01)
        else:
            self.fail('running thread never released its slot')

    async def test_cancelled_waiter_frees_its_bounded_queue_position(self):
        self.limiter.close()
        self.limiter = WorkLimiter(1, 'cancel-queue', max_waiting=1)
        first = await self.start_first()
        request = FakeRequest()
        cancelled = asyncio.create_task(self.limiter.run(request, self.second))
        self.tasks.append(cancelled)
        await asyncio.wait_for(request.listening.wait(), 1)
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled
        replacement = FakeRequest()
        queued = asyncio.create_task(self.limiter.run(replacement, self.second))
        self.tasks.append(queued)
        await asyncio.wait_for(replacement.listening.wait(), 1)
        self.release.set()
        self.assertEqual(await first, 'first')
        self.assertEqual(await queued, 'second')

    async def test_running_and_waiting_limits_are_shared_across_event_loops(self):
        self.limiter.close()
        self.limiter = WorkLimiter(1, 'cross-loop', max_waiting=1, wait_seconds=3)
        first = await self.start_first()
        registered = threading.Event()

        class OtherLoopRequest(FakeRequest):
            async def receive(self):
                registered.set()
                return await super().receive()

        def other_loop():
            return asyncio.run(self.limiter.run(OtherLoopRequest(), self.second))

        queued = asyncio.create_task(asyncio.to_thread(other_loop))
        self.tasks.append(queued)
        self.assertTrue(await asyncio.to_thread(registered.wait, 2))
        with self.assertRaises(HTTPException) as caught:
            await self.limiter.run(FakeRequest(), self.second)
        self.assertEqual(caught.exception.detail['code'], CAPACITY_ERROR_CODE)
        self.assertFalse(self.second_started.is_set())
        self.release.set()
        self.assertEqual(await first, 'first')
        self.assertEqual(await asyncio.wait_for(queued, 3), 'second')

    async def test_burst_admits_only_running_plus_bounded_waiters(self):
        self.limiter.close()
        self.limiter = WorkLimiter(2, 'burst', max_waiting=3, wait_seconds=3)
        started = threading.Event()
        release = threading.Event()
        lock = threading.Lock()
        calls = []
        active = 0
        peak = 0

        def work(index):
            nonlocal active, peak
            with lock:
                calls.append(index)
                active += 1
                peak = max(peak, active)
                if len(calls) == 2:
                    started.set()
            try:
                if not release.wait(5):
                    raise RuntimeError('test did not release burst')
                return index
            finally:
                with lock:
                    active -= 1

        tasks = [asyncio.create_task(self.limiter.run(FakeRequest(), work, i)) for i in range(2)]
        self.tasks.extend(tasks)
        try:
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            burst = [asyncio.create_task(self.limiter.run(FakeRequest(), work, i)) for i in range(2, 22)]
            self.tasks.extend(burst)
            async def wait_until_bounded():
                while True:
                    with self.limiter._lock:
                        waiting = len(self.limiter._waiters)
                    if waiting == 3 and sum(task.done() for task in burst) == 17:
                        return
                    await asyncio.sleep(0.01)
            await asyncio.wait_for(wait_until_bounded(), 2)
            release.set()
            results = await asyncio.wait_for(asyncio.gather(*tasks, *burst, return_exceptions=True), 5)
            successes = [item for item in results if isinstance(item, int)]
            refusals = [item for item in results if isinstance(item, HTTPException)]
            self.assertEqual(len(successes), 5)
            self.assertEqual(len(refusals), 17)
            self.assertTrue(all(item.detail['code'] == CAPACITY_ERROR_CODE for item in refusals))
            self.assertEqual(len(calls), 5)
            self.assertLessEqual(peak, 2)
        finally:
            release.set()

    async def test_cancel_racing_slot_handoff_does_not_leak_capacity(self):
        self.limiter.close()
        self.limiter = WorkLimiter(1, 'handoff', max_waiting=1)
        for _ in range(25):
            started, release = threading.Event(), threading.Event()
            def blocking():
                started.set()
                if not release.wait(3):
                    raise RuntimeError('test did not release work')
            first = asyncio.create_task(self.limiter.run(FakeRequest(), blocking))
            self.tasks.append(first)
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            request = FakeRequest()
            queued = asyncio.create_task(self.limiter.run(request, self.second))
            self.tasks.append(queued)
            await asyncio.wait_for(request.listening.wait(), 1)
            release.set()
            queued.cancel()
            await asyncio.gather(first, queued, return_exceptions=True)
            self.assertEqual(await asyncio.wait_for(self.limiter.run(FakeRequest(), self.second), 2), 'second')


class WorkConfigurationTests(unittest.TestCase):
    def test_limits_reject_invalid_values(self):
        for value in ('0', '-1', '33', '1.5', 'invalid', ''):
            with self.subTest(value=value), mock.patch.dict(os.environ, {'TEST_WORK_LIMIT': value}):
                with self.assertRaises(ValueError):
                    limit_from_env('TEST_WORK_LIMIT')
        with mock.patch.dict(os.environ, {'TEST_WORK_LIMIT': '2'}):
            self.assertEqual(limit_from_env('TEST_WORK_LIMIT'), 2)

    def test_waiting_limits_allow_zero_but_reject_invalid_or_excessive_values(self):
        for value in ('-1', '129', '1.5', 'invalid', ''):
            with self.subTest(value=value), mock.patch.dict(os.environ, {'TEST_WAIT_LIMIT': value}):
                with self.assertRaises(ValueError):
                    waiting_limit_from_env('TEST_WAIT_LIMIT')
        for value in (0, 4, 128):
            with self.subTest(value=value), mock.patch.dict(os.environ, {'TEST_WAIT_LIMIT': str(value)}):
                self.assertEqual(waiting_limit_from_env('TEST_WAIT_LIMIT'), value)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(waiting_limit_from_env('TEST_WAIT_LIMIT'), 4)
        with self.assertRaises(ValueError):
            WorkLimiter(1, 'bad', max_waiting=129)

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
