import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import wave
from engine.openai_trial import (MODELS, TrialError, prepare_audio, multipart,
                                 clean_response, run_trial)


def pcm(seconds=1):
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(b'\x00\x00' * round(seconds * 16000))
    return stream.getvalue()


class TrialTests(unittest.TestCase):
    def test_hash_duration_and_original_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            data = pcm(55)
            path = Path(directory) / 'private.wav'; path.write_bytes(data)
            audio, duration, digest = prepare_audio(path, hashlib.sha256(data).hexdigest())
            self.assertEqual((audio, duration), (data, 55))
            with self.assertRaisesRegex(TrialError, 'audio_changed'):
                prepare_audio(path, '0' * 64)

    def test_audio_over_approved_duration_is_rejected_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            data = pcm(55.01)
            path = Path(directory) / 'private.wav'; path.write_bytes(data)
            with self.assertRaisesRegex(TrialError, 'scope_exceeded'):
                prepare_audio(path, hashlib.sha256(data).hexdigest())

    def test_payload_has_no_lyrics_reference_times_or_private_filename(self):
        for model in MODELS:
            content_type, body = multipart(model, b'PCM_AUDIO')
            self.assertIn('boundary=', content_type)
            self.assertIn(b'filename="trial.wav"', body)
            for forbidden in (b'lyrics', b'prompt', b'reference', b'DO_NOT_SEND', b'private.wav'):
                self.assertNotIn(forbidden, body)
            self.assertIn(b'PCM_AUDIO', body)
        with self.assertRaises(TrialError):
            multipart('other-model', b'PCM_AUDIO')

    def test_two_requests_only_and_second_execution_rejected(self):
        calls = []
        def transport(key, content_type, body):
            calls.append(body)
            return {'text': '歌', 'words': [{'word': '歌', 'start': 0, 'end': .8}],
                    'usage': {'seconds': 1, 'other': 'not stored'}}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            result = run_trial(pcm(), 1, 'hash', output, 'test-only-key', transport)
            self.assertEqual(len(calls), 2)
            self.assertEqual(result['status'], 'complete')
            self.assertEqual(result['estimatedUsd'], .000175)
            self.assertNotIn('test-only-key', (output / 'attempt.json').read_text())
            with self.assertRaisesRegex(TrialError, 'already_consumed'):
                run_trial(pcm(), 1, 'hash', output, 'test-only-key', transport)
            self.assertEqual(len(calls), 2)

    def test_failure_stops_second_request_and_cannot_resume(self):
        calls = []
        def transport(*args):
            calls.append(1)
            raise TrialError('http_429_insufficient_quota')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with self.assertRaisesRegex(TrialError, 'insufficient_quota'):
                run_trial(pcm(), 1, 'hash', output, 'test-only-key', transport)
            self.assertEqual(calls, [1])
            ledger = json.loads((output / 'attempt.json').read_text())
            self.assertEqual(ledger['status'], 'stopped_no_retry')
            self.assertEqual(len(ledger['attempts']), 1)
            with self.assertRaisesRegex(TrialError, 'already_consumed'):
                run_trial(pcm(), 1, 'hash', output, 'test-only-key', transport)
            self.assertEqual(calls, [1])

    def test_arbitrary_error_never_persists_key_or_remote_message(self):
        def transport(*args):
            raise RuntimeError('secret-value-and-remote-content')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with self.assertRaisesRegex(TrialError, 'network_or_response_failure'):
                run_trial(pcm(), 1, 'hash', output, 'test-only-key', transport)
            self.assertNotIn('secret-value', (output / 'attempt.json').read_text())

    def test_invalid_acoustic_times_are_not_repaired_or_fabricated(self):
        for start, end in [(-1, .5), (.8, .2), (0, 2), (True, .5), (0, float('nan'))]:
            with self.subTest(start=start, end=end):
                with self.assertRaisesRegex(TrialError, 'invalid_word_interval'):
                    clean_response({'text': '歌', 'words': [{'word': '歌', 'start': start, 'end': end}]}, 1)

    def test_zero_duration_token_is_kept_as_evidence_not_stretched(self):
        result = clean_response({'text': 'の', 'words': [{'word': 'の', 'start': .5, 'end': .5}]}, 1)
        self.assertEqual(result['words'], [])
        self.assertEqual(result['zeroDurationWords'], [{'text': 'の', 'start': .5, 'end': .5}])


if __name__ == '__main__':
    unittest.main()
