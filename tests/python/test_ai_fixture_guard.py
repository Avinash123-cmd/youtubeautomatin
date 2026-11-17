"""Fixture inference is isolated-test-only, never a production escape hatch."""
import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
config = importlib.import_module('services.ai-engine.app.config')
class FixtureGuardTests(unittest.TestCase):
    def test_production_refuses_fixture_even_with_test_mode(self):
        base = {'AI_ENGINE_API_KEY': 'test-only', 'AI_PROVIDER': 'fixture', 'TEST_MODE': '1', 'WHISPER_MODEL': 'test-only', 'WORK_DIR': '/tmp/test-only', 'FFMPEG_PATH': 'ffmpeg', 'FFPROBE_PATH': 'ffprobe'}
        for flag in [{'NODE_ENV': 'production'}, {'RENDER': 'true'}]:
            with self.subTest(flag=flag), patch.dict(os.environ, {**base, **flag}, clear=True):
                with self.assertRaises(config.ConfigurationError): config.load_settings()
    def test_explicit_isolated_test_mode_remains_supported(self):
        with patch.dict(os.environ, {'AI_ENGINE_API_KEY': 'test-only', 'AI_PROVIDER': 'fixture', 'TEST_MODE': '1', 'WHISPER_MODEL': 'test-only', 'WORK_DIR': '/tmp/test-only', 'FFMPEG_PATH': 'ffmpeg', 'FFPROBE_PATH': 'ffprobe'}, clear=True):
            self.assertTrue(config.load_settings().test_mode)
