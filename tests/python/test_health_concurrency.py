"""Expensive service work must be bounded without starving probes or retries."""
import asyncio
import importlib
import threading
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest import mock

import httpx

from services.work_limits import WorkLimiter

vp = importlib.import_module('services.video-processor.app.main')
ai = importlib.import_module('services.ai-engine.app.main')


class HealthConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, module, first_path, first_payload, first_work, second_path, second_payload, second_work):
        limiter = WorkLimiter(1, 'test-work')
        first_started = threading.Event()
        release = threading.Event()
        second_started = threading.Event()
        active = 0
        peak = 0
        lock = threading.Lock()

        def run_first(*_args, **_kwargs):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            first_started.set()
            try:
                if not release.wait(10):
                    raise RuntimeError('test did not release the worker')
                return {'ok': True}
            finally:
                with lock:
                    active -= 1

        def run_second(*_args, **_kwargs):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            second_started.set()
            with lock:
                active -= 1
            return {'ok': True}

        tasks = []
        try:
            with mock.patch.object(module, '_work_limiter', limiter), \
                 mock.patch.object(module, first_work, side_effect=run_first), \
                 mock.patch.object(module, second_work, side_effect=run_second):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url='http://test') as client:
                    tasks.append(asyncio.create_task(client.post(first_path, json=first_payload, headers={'x-api-key': 'test-key'})))
                    self.assertTrue(await asyncio.to_thread(first_started.wait, 3))
                    tasks.append(asyncio.create_task(client.post(second_path, json=second_payload, headers={'x-api-key': 'test-key'})))
                    await asyncio.sleep(0.1)
                    self.assertFalse(second_started.is_set(), 'a second expensive route exceeded the work limit')
                    # Waiting work does not occupy FastAPI's request thread pool or
                    # turn probes/authentication into a capacity error.
                    live = await asyncio.wait_for(client.get('/live'), timeout=2)
                    health = await asyncio.wait_for(client.get('/health'), timeout=2)
                    denied = await asyncio.wait_for(client.post(second_path, json=second_payload, headers={'x-api-key': 'wrong'}), timeout=2)
                    self.assertEqual(live.status_code, 200)
                    self.assertEqual(health.status_code, 200)
                    self.assertEqual(denied.status_code, 401)
                    release.set()
                    responses = await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)
                    self.assertTrue(all(response.status_code == 200 for response in responses))
                    self.assertTrue(second_started.is_set())
                    self.assertEqual(peak, 1)
        finally:
            release.set()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            limiter.close()

    async def test_video_render_and_audio_analysis_share_a_limit(self):
        render = dict(source_path='/source', output_path='/output', start=0, end=1,
                      words=[{'word': 'hi', 'start': 0, 'end': 1}], subtitle_style={},
                      output_width=1080, output_height=1920, fps=30, bitrate_kbps=2000,
                      framing_mode='center_crop', framing_fallback='center_crop', loudness_target_lufs=-14)
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(vp, 'API_KEY', 'test-key'))
            stack.enter_context(mock.patch.object(vp.subprocess, 'run', return_value=SimpleNamespace(stdout='version\n')))
            await self.exercise(vp, '/render', render, '_render_work', '/audio-analysis', {'path': '/source'}, '_audio_analysis_work')

    async def test_video_probes_are_bounded_but_independent_of_rendering(self):
        render_limit = WorkLimiter(1, 'test-render')
        probe_limit = WorkLimiter(1, 'test-probe')
        render_started, release_render = threading.Event(), threading.Event()
        probe_started, release_probe, second_started = threading.Event(), threading.Event(), threading.Event()
        render_payload = dict(source_path='/source', output_path='/output', start=0, end=1,
                              words=[{'word': 'hi', 'start': 0, 'end': 1}], subtitle_style={},
                              output_width=1080, output_height=1920, fps=30, bitrate_kbps=2000,
                              framing_mode='center_crop', framing_fallback='center_crop', loudness_target_lufs=-14)

        def render(_payload):
            render_started.set()
            if not release_render.wait(10):
                raise RuntimeError('test did not release render')
            return {'ok': True}

        def probe(payload):
            if payload.path == '/first':
                probe_started.set()
                if not release_probe.wait(10):
                    raise RuntimeError('test did not release probe')
            else:
                second_started.set()
            return {'path': payload.path}

        tasks = []
        try:
            with ExitStack() as stack:
                stack.enter_context(mock.patch.object(vp, 'API_KEY', 'test-key'))
                stack.enter_context(mock.patch.object(vp, '_work_limiter', render_limit))
                stack.enter_context(mock.patch.object(vp, '_probe_limiter', probe_limit))
                stack.enter_context(mock.patch.object(vp, '_render_work', side_effect=render))
                stack.enter_context(mock.patch.object(vp, '_probe_work', side_effect=probe))
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=vp.app), base_url='http://test') as client:
                    headers = {'x-api-key': 'test-key'}
                    tasks.append(asyncio.create_task(client.post('/render', json=render_payload, headers=headers)))
                    self.assertTrue(await asyncio.to_thread(render_started.wait, 3))
                    tasks.append(asyncio.create_task(client.post('/probe', json={'path': '/first'}, headers=headers)))
                    self.assertTrue(await asyncio.to_thread(probe_started.wait, 3), 'render blocked the probe pool')
                    tasks.append(asyncio.create_task(client.post('/probe', json={'path': '/second'}, headers=headers)))
                    await asyncio.sleep(0.1)
                    self.assertFalse(second_started.is_set(), 'probe limit was exceeded')
                    release_probe.set()
                    self.assertEqual((await asyncio.wait_for(tasks[1], 3)).status_code, 200)
                    self.assertEqual((await asyncio.wait_for(tasks[2], 3)).status_code, 200)
                    self.assertTrue(second_started.is_set())
                    self.assertFalse(tasks[0].done(), 'render unexpectedly stopped')
                    release_render.set()
                    self.assertEqual((await asyncio.wait_for(tasks[0], 3)).status_code, 200)
        finally:
            release_probe.set()
            release_render.set()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            render_limit.close()
            probe_limit.close()

    async def test_ai_captions_and_transcription_share_a_limit(self):
        cfg = SimpleNamespace(api_key='test-key', provider='fixture', test_mode=True, gemini_configured=False,
                              ffmpeg_path='ffmpeg', ffprobe_path='ffprobe', whisper_model='small')
        captions = {'model': 'fixture', 'clips': [{'clip_id': 'one', 'transcript': 'hello'}]}
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(ai, 'settings', return_value=cfg))
            stack.enter_context(mock.patch.object(ai.shutil, 'which', return_value='/usr/bin/tool'))
            await self.exercise(ai, '/captions', captions, '_captions_work', '/transcribe', {'audio_path': '/audio'}, '_transcribe_work')


if __name__ == '__main__':
    unittest.main()
