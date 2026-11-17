"""Real FFmpeg HTTP render smoke; synthetic media/timings are isolated fixtures, not AI evidence."""
import importlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
vp = importlib.import_module('services.video-processor.app.main')

@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe are required')
class RenderHttpTests(unittest.TestCase):
    def test_vertical_render_with_burned_timed_subtitles_and_verified_codecs(self):
        with tempfile.TemporaryDirectory() as directory:
            source = str(Path(directory) / 'source.mp4')
            output = str(Path(directory) / 'rendered.mp4')
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', source], check=True, capture_output=True)
            style = dict(fontFamily='DejaVu Sans', fontSizePx=22, fontWeight=700, primaryColor='#FFFFFF', highlightColor='#FFFF00', outlineColor='#000000', outlineWidth=2, shadow=1, position='bottom', safeMarginXPx=10, safeMarginBottomPx=30, backgroundOpacity=0, uppercase=False, maxCharsPerLine=18, maxLines=2)
            payload = dict(source_path=source, output_path=output, start=0, end=3, words=[dict(word='Render', start=0.1, end=1.2, probability=1), dict(word='verified', start=1.3, end=2.7, probability=1)], subtitle_style=style, output_width=202, output_height=360, fps=30, bitrate_kbps=1000, framing_mode='center_crop', framing_fallback='fail', loudness_target_lufs=-14)
            with patch.object(vp, 'API_KEY', 'test-key'), patch.object(vp, 'WORK_DIR', directory):
                response = TestClient(vp.app).post('/render', headers={'x-api-key': 'test-key'}, json=payload)
            self.assertEqual(response.status_code, 200, response.text)
            report = response.json()
            self.assertEqual((report['width'], report['height']), (202, 360))
            self.assertEqual((report['videoCodec'], report['audioCodec']), ('h264', 'aac'))
            self.assertEqual(report['subtitleWordCount'], 2)
            self.assertEqual(report['validationErrors'], [])
            self.assertGreater(Path(output).stat().st_size, 1000)
