"""Real validation/selection tests; model responses are explicit isolated test inputs."""
import importlib
import math
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
timing = importlib.import_module('services.ai-engine.app.timing')
selection = importlib.import_module('services.ai-engine.app.selection')
pipeline = importlib.import_module('services.ai-engine.app.pipeline')
transcribe = importlib.import_module('services.ai-engine.app.transcribe')


def transcript():
    return dict(language='en', language_probability=1, model='test-input', segments=[dict(start=0., end=15., text='A complete explanation with enough words to understand.', words=[dict(word=w, start=i*1.5, end=(i+1)*1.5) for i, w in enumerate('A complete explanation with enough words to understand.'.split())])])


def candidate():
    return dict(start_time=0, end_time=15, target_duration=15, transcript='', scores={key: 9 for key in selection.RUBRIC}, quality_score=90, confidence=.9)


class TimingTests(unittest.TestCase):
    def test_preserves_exact_provider_timing_and_speaker(self):
        value = transcript(); value['segments'][0]['speaker_label'] = 'speaker-1'
        self.assertIs(timing.validate_transcript(value, 20), value)
        self.assertEqual(value['segments'][0]['words'][1]['start'], 1.5)
        self.assertEqual(value['segments'][0]['speaker_label'], 'speaker-1')

    def test_rejects_invalid_ranges(self):
        for start, end in [(math.nan, 3), (0, math.inf), (-1, 3), (4, 2), (0, 99), (True, 3)]:
            with self.subTest(start=start, end=end):
                value = transcript(); value['segments'][0].update(start=start, end=end)
                with self.assertRaises(timing.TranscriptTimingError): timing.validate_transcript(value, 20)

    def test_rejects_unordered_words_and_outside_segment(self):
        for change in [dict(start=16, end=17), dict(start=0, end=1)]:
            value = transcript(); value['segments'][0]['words'][-1].update(change)
            with self.assertRaises(timing.TranscriptTimingError): timing.validate_transcript(value, 20)

    def test_rejects_nonchronological_segments(self):
        value = transcript(); value['segments'].insert(0, dict(start=16, end=18, text='Later', words=[]))
        with self.assertRaises(timing.TranscriptTimingError): timing.validate_transcript(value, 20)

    def test_transcriber_preserves_real_model_word_output(self):
        word = SimpleNamespace(word=' Actual', start=.125, end=.875, probability=.95)
        segment = SimpleNamespace(start=.125, end=.875, text=' Actual', words=[word], avg_logprob=-.1, no_speech_prob=.01)
        model = SimpleNamespace(transcribe=lambda *args, **kwargs: (iter([segment]), SimpleNamespace(language='en', language_probability=.99, duration=1)))
        with patch.object(transcribe, '_load_model', return_value=model):
            result = transcribe.transcribe(SimpleNamespace(whisper_model='test-model'), 'test.wav')
        self.assertEqual(result['segments'][0]['words'][0]['start'], .125)
        self.assertEqual(result['full_text'], 'Actual')
        # Adapter test only: no model inference claimed.


class SelectionIntegrityTests(unittest.TestCase):
    def validate(self, value):
        return selection.validate_and_normalise({'candidates': [value]}, segments=transcript()['segments'], duration_seconds=20, target_durations=[15], min_quality_score=50)

    def test_invalid_numbers_are_rejected_not_crashes_or_quality(self):
        for field, value in [('start_time', math.nan), ('end_time', math.inf), ('quality_score', 'bad'), ('confidence', math.nan), ('scores', None)]:
            with self.subTest(field=field):
                item = candidate(); item[field] = value
                accepted, rejected, _ = self.validate(item)
                self.assertEqual(accepted, []); self.assertEqual(len(rejected), 1)

    def test_uses_source_words_not_model_invention(self):
        item = candidate(); item['transcript'] = 'An invented claim absent from the source.'
        accepted, _, _ = self.validate(item)
        self.assertEqual(len(accepted), 1)
        self.assertNotIn('invented', accepted[0].transcript)
        self.assertEqual(accepted[0].quality_score, 90)

    def test_no_entire_segment_fallback_inside_word_timing_gap(self):
        segments = [dict(start=0, end=15, text='Speech elsewhere', words=[dict(word='Speech', start=0, end=1), dict(word='elsewhere', start=14, end=15)])]
        self.assertEqual(selection._transcript_for_window(segments, 3, 10), '')

    def test_wordless_partial_segment_does_not_invent_excerpt(self):
        self.assertEqual(selection._transcript_for_window([dict(start=0, end=15, text='Full text', words=[])], 3, 10), '')

    def test_analysis_without_vision_has_zero_usage_and_honest_empty_result(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.mp4'; source.touch()
            audio = Path(directory) / 'audio.wav'; audio.touch()
            settings = SimpleNamespace(provider='fixture', work_dir=directory)
            probe = SimpleNamespace(audio_codec='aac', duration_seconds=20, as_dict=lambda: {'duration_seconds': 20})
            with patch.object(pipeline.media, 'probe', return_value=probe), patch.object(pipeline.media, 'extract_audio', return_value=audio), patch.object(pipeline.fixture_provider, 'propose_candidates', return_value={'candidates': []}):
                result = pipeline.analyze(settings, dict(job_id='test', video_path=str(source), transcript=transcript(), enable_vision=False))
            self.assertEqual(result['report']['usage']['vision']['total_tokens'], 0)
            self.assertEqual(result['report']['outcome'], 'NO_QUALITY_CANDIDATES')
            self.assertEqual(result['plan'], [])


gemini = importlib.import_module('services.ai-engine.app.gemini')


class StructuredOutputTests(unittest.TestCase):
    def test_rejects_missing_candidate_fields_and_types(self):
        for value in [[], {'candidates': []}, {'candidates': [{'start_time': 'bad'}], 'video_summary': '', 'content_themes': [], 'no_candidate_reason': ''}]:
            with self.subTest(value=value):
                with self.assertRaises(gemini.SchemaValidationError):
                    gemini.validate_structured(value, selection.RESPONSE_SCHEMA)

    def test_rejects_invalid_numeric_or_enum_values(self):
        for value, schema in [(math.nan, {'type': 'number'}), (True, {'type': 'integer'}), ('bad', {'type': 'string', 'enum': ['good']})]:
            with self.assertRaises(gemini.SchemaValidationError): gemini.validate_structured(value, schema)

    def test_provider_client_validates_json_success_and_keeps_key_out_of_url(self):
        settings = SimpleNamespace(gemini_api_key='test-only-secret', gemini_endpoint='https://example.invalid', request_timeout_seconds=1, max_retries=1)
        response = SimpleNamespace(status_code=200, json=lambda: {'candidates': [{'content': {'parts': [{'text': '{"wrong":true}'}]}}]})
        with patch.object(gemini.httpx, 'Client') as client:
            client.return_value.__enter__.return_value.post.return_value = response
            with self.assertRaises(gemini.SchemaValidationError):
                gemini.GeminiClient(settings).generate_structured(model='test', system_instruction='test', parts=[], response_schema=selection.RESPONSE_SCHEMA)
            call = client.return_value.__enter__.return_value.post.call_args
            self.assertNotIn('params', call.kwargs)
            self.assertEqual(call.kwargs['headers']['x-goog-api-key'], 'test-only-secret')

    def test_accepts_honest_empty_candidates(self):
        gemini.validate_structured({'candidates': [], 'video_summary': '', 'content_themes': [], 'no_candidate_reason': 'No speech'}, selection.RESPONSE_SCHEMA)


class RealAnalysisMediaTests(unittest.TestCase):
    def test_real_probe_audio_extraction_and_scene_scan(self):
        import shutil
        import subprocess
        import wave
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            self.skipTest('FFmpeg and FFprobe required')
        media = importlib.import_module('services.ai-engine.app.media')
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', str(source)], check=True, capture_output=True)
            settings = SimpleNamespace(ffmpeg_path='ffmpeg', ffprobe_path='ffprobe')
            info = media.probe(settings, source)
            self.assertAlmostEqual(info.duration_seconds, 3, delta=.15)
            self.assertEqual((info.width, info.height), (320, 180))
            audio = media.extract_audio(settings, source, Path(directory) / 'audio.wav')
            with wave.open(str(audio)) as wav:
                self.assertEqual(wav.getframerate(), 16000); self.assertEqual(wav.getnchannels(), 1)
                self.assertAlmostEqual(wav.getnframes() / wav.getframerate(), 3, delta=.15)
            self.assertIsInstance(media.detect_scenes(settings, source), list)
            with self.assertRaises(media.MediaError): media.detect_scenes(settings, Path(directory) / 'missing.mp4')
