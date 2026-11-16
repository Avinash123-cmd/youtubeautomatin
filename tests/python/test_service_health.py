"""HTTP boundary tests: tools/providers are stubbed; no render or cloud inference is claimed."""
import importlib
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from fastapi.testclient import TestClient

vp = importlib.import_module('services.video-processor.app.main')
ai = importlib.import_module('services.ai-engine.app.main')


class VideoHealthTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(vp.app)

    def test_missing_binary_returns_503_not_fake_success(self):
        with mock.patch.object(vp.subprocess, 'run', side_effect=FileNotFoundError('/private/tool')):
            response = self.client.get('/health')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['status'], 'down')
        self.assertNotIn('/private', response.text)

    def test_failed_binary_returns_503(self):
        with mock.patch.object(vp.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'ffmpeg')):
            self.assertEqual(self.client.get('/health').status_code, 503)

    def test_tools_without_key_are_unconfigured(self):
        with mock.patch.object(vp, 'API_KEY', None), mock.patch.object(vp.subprocess, 'run', return_value=SimpleNamespace(stdout='version\n')):
            response = self.client.get('/health')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['status'], 'unconfigured')

    def test_tools_and_key_report_healthy(self):
        with mock.patch.object(vp, 'API_KEY', 'test-key'), mock.patch.object(vp.subprocess, 'run', return_value=SimpleNamespace(stdout='version\n')):
            self.assertEqual(self.client.get('/health').status_code, 200)

    def test_liveness_is_separate(self):
        self.assertEqual(self.client.get('/live').status_code, 200)

    def test_non_ascii_invalid_key_is_401_not_500(self):
        with mock.patch.object(vp, 'API_KEY', 'test-key'):
            response = self.client.post('/probe', headers={b'x-api-key': b'\xff'}, json={'path': '/private'})
        self.assertEqual(response.status_code, 401)

    def test_render_rejects_invalid_window_before_work(self):
        payload = dict(source_path='/source', output_path='/output', start=20, end=10, words=[], subtitle_style={}, output_width=1080, output_height=1920, fps=30, bitrate_kbps=2000, framing_mode='center_crop', framing_fallback='center_crop', loudness_target_lufs=-14)
        with mock.patch.object(vp, 'API_KEY', 'test-key'), mock.patch.object(vp.renderer, 'render_clip') as render:
            response = self.client.post('/render', headers={'x-api-key': 'test-key'}, json=payload)
        self.assertEqual(response.status_code, 422)
        render.assert_not_called()


class AiHealthTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(ai.app)

    def test_missing_config_reports_503(self):
        with mock.patch.object(ai, 'settings', side_effect=ai.HTTPException(status_code=503)):
            self.assertEqual(self.client.get('/health').status_code, 503)

    def test_missing_tools_cannot_report_ready(self):
        cfg = SimpleNamespace(ffmpeg_path='ffmpeg', ffprobe_path='ffprobe', provider='gemini', test_mode=False, gemini_configured=True, whisper_model='small')
        with mock.patch.object(ai, 'settings', return_value=cfg), mock.patch.object(ai.shutil, 'which', return_value=None):
            response = self.client.get('/health')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['status'], 'down')

    def test_rejects_job_directory_traversal(self):
        with self.assertRaises(ValueError):
            ai.AnalyzeRequest(job_id='../../private', video_path='/video')


if __name__ == '__main__':
    unittest.main()
