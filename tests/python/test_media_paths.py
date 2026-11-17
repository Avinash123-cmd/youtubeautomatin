import importlib
import tempfile
import unittest
from pathlib import Path
from fastapi import HTTPException
from fastapi.testclient import TestClient
from unittest.mock import patch
from services.media_paths import media_path
vp = importlib.import_module('services.video-processor.app.main')
ai = importlib.import_module('services.ai-engine.app.main')

class MediaPathTests(unittest.TestCase):
    def test_containment_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            source = root / 'source.mp4'
            source.write_bytes(b'not-real-media')
            self.assertEqual(media_path(str(source), directory), str(source))
            self.assertEqual(media_path(str(root / 'output.mp4'), directory, output=True), str(root / 'output.mp4'))
            (root / 'escape').symlink_to(outside, target_is_directory=True)
            for path in ['/etc/passwd', 'https://example.com/video', 'relative.mp4', str(root), str(root / 'escape/output.mp4'), str(root / '../outside.mp4')]:
                with self.subTest(path=path), self.assertRaises(HTTPException):
                    media_path(path, directory, output=True)
            with self.assertRaises(HTTPException): media_path(str(root / 'missing.mp4'), directory)

    def test_processor_rejects_external_paths_before_subprocess(self):
        client = TestClient(vp.app)
        with patch.object(vp, 'API_KEY', 'test-key'), patch.object(vp.renderer, 'probe_summary') as probe:
            response = client.post('/probe', headers={'x-api-key': 'test-key'}, json={'path': '/etc/passwd'})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn('/etc/passwd', response.text)
        probe.assert_not_called()

    def test_ai_rejects_external_paths_before_inference(self):
        from types import SimpleNamespace
        client = TestClient(ai.app)
        with patch.object(ai, 'settings', return_value=SimpleNamespace(api_key='test-key', work_dir='/data/work')), patch.object(ai.pipeline, 'analyze') as analyze:
            response = client.post('/analyze', headers={'x-api-key': 'test-key'}, json={'job_id': 'job-a', 'video_path': '/etc/passwd'})
        self.assertEqual(response.status_code, 422)
        analyze.assert_not_called()
