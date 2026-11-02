"""Opt-in, two-request acoustic experiment. Never imported by the Web UI.

Requires separate key-reuse and audio-transfer approval. No SDK retries, lyric
upload, key files, purchases, redirects, or model substitution. Results and the
non-retry ledger stay in ignored .studio-data. This is not production alignment.
"""
import argparse
import hashlib
import http.client
import io
import json
import math
import os
from pathlib import Path
import re
import ssl
import time
import uuid
import wave

MODELS = ('gpt-transcribe', 'whisper-1')
RATES = {'gpt-transcribe': .0045, 'whisper-1': .006}
MAX_SECONDS = 55.001
MAX_BYTES = 2_000_000
MAX_RESPONSE = 4_000_000


class TrialError(Exception):
    """Only safe identifiers, never remote error text, headers or key values."""


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def prepare_audio(path, expected_sha256):
    if not re.fullmatch(r'[a-fA-F0-9]{64}', expected_sha256):
        raise TrialError('expected_audio_hash_required')
    if path.stat().st_size > MAX_BYTES:
        raise TrialError('audio_too_large')
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_sha256.lower():
        raise TrialError('audio_changed_since_approval')
    with wave.open(io.BytesIO(data), 'rb') as wav:
        duration = wav.getnframes() / wav.getframerate()
        if (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) != (1, 16000, 2):
            raise TrialError('require_pcm16_16khz_mono')
        if not 0 < duration <= MAX_SECONDS:
            raise TrialError('approved_55_second_scope_exceeded')
        if len(wav.readframes(wav.getnframes())) != wav.getnframes() * 2:
            raise TrialError('truncated_audio')
    return data, duration, digest


def multipart(model, audio):
    if model not in MODELS:
        raise TrialError('unapproved_model')
    fields = [('model', model), ('response_format', 'json')]
    if model == 'whisper-1':
        fields = [('model', model), ('response_format', 'verbose_json'),
                  ('language', 'ja'), ('timestamp_granularities[]', 'word')]
    boundary = 'lyric-trial-' + uuid.uuid4().hex
    body = bytearray()
    for name, value in fields:
        body.extend((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'
                     f'\r\n\r\n{value}\r\n').encode())
    # A generic filename avoids sending the song name or a private file path.
    body.extend((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                 'filename="trial.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode())
    body.extend(audio)
    body.extend(f'\r\n--{boundary}--\r\n'.encode())
    return 'multipart/form-data; boundary=' + boundary, bytes(body)


def post_once(key, content_type, body):
    """One HTTPS POST to the consented official host, with no retry/followup."""
    connection = http.client.HTTPSConnection('api.openai.com', timeout=180,
                                            context=ssl.create_default_context())
    try:
        connection.request('POST', '/v1/audio/transcriptions', body=body,
                           headers={'Authorization': 'Bearer ' + key,
                                    'Content-Type': content_type,
                                    'Content-Length': str(len(body))})
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            raise TrialError('response_too_large')
        if response.status != 200:
            code = ''
            try:
                remote = json.loads(data).get('error', {}).get('code')
                if isinstance(remote, str) and re.fullmatch(r'[a-z_]{1,60}', remote):
                    code = '_' + remote
            except (ValueError, AttributeError):
                pass
            raise TrialError(f'http_{response.status}{code}')
        return json.loads(data)
    finally:
        connection.close()


def clean_response(response, duration):
    text = response.get('text')
    if not isinstance(text, str) or len(text) > 100_000:
        raise TrialError('invalid_transcript_response')
    words, zero_duration_words = [], []
    for word in response.get('words', []):
        start, end = word.get('start'), word.get('end')
        if (not isinstance(word.get('word'), str) or
                any(isinstance(t, bool) or not isinstance(t, (int, float)) or
                    not math.isfinite(t) for t in (start, end)) or
                not 0 <= start <= end <= duration + .15):
            raise TrialError('invalid_word_interval')
        if start == end:
            # Some Japanese tokens have a zero-length acoustic estimate. Keep
            # the evidence but never stretch it to invent a usable interval.
            zero_duration_words.append({'text': word['word'], 'start': start, 'end': end})
            continue
        words.append({'text': word['word'], 'start_time': start, 'end_time': end})
    usage = {k: v for k, v in response.get('usage', {}).items()
             if k in ('seconds', 'input_tokens', 'output_tokens', 'total_tokens')
             and isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)}
    return {'text': text, 'words': words, 'zeroDurationWords': zero_duration_words, 'usage': usage}


def run_trial(audio, duration, digest, output, key, transport=post_once):
    """Reserve the entire consent before a request; uncertain runs cannot resume."""
    output.mkdir(parents=True, exist_ok=True)
    ledger = output / 'attempt.json'
    record = {'audioSha256': digest, 'duration': duration, 'models': list(MODELS),
              'lyricsUploaded': False, 'referenceTimesUploaded': False,
              'automaticRetries': 0, 'attempts': [], 'status': 'reserved',
              'estimatedUsd': round(duration / 60 * sum(RATES.values()), 8)}
    if not key or record['estimatedUsd'] >= .02:
        raise TrialError('missing_key_or_budget_exceeded')
    # Exclusive creation is intentional: never retry the other model after a
    # failure, timeout, process interruption, or second command invocation.
    try:
        with ledger.open('x', encoding='utf-8') as stream:
            json.dump(record, stream)
    except FileExistsError:
        raise TrialError('consent_already_consumed_no_retry') from None
    for model in MODELS:
        item = {'model': model, 'status': 'started',
                'estimatedUsd': round(duration / 60 * RATES[model], 8)}
        record['attempts'].append(item)
        write_json(ledger, record)
        started = time.monotonic()
        try:
            content_type, body = multipart(model, audio)
            result = clean_response(transport(key, content_type, body), duration)
            if model == 'whisper-1' and not result['words']:
                raise TrialError('no_acoustic_word_times')
            result.update(model=model, duration=duration,
                          elapsedSeconds=round(time.monotonic() - started, 2))
            write_json(output / (model + '.json'), result)
            item.update(status='success', elapsedSeconds=result['elapsedSeconds'],
                        usage=result['usage'])
        except Exception as error:
            # Never save or print arbitrary exception/remote message text.
            safe = str(error) if isinstance(error, TrialError) else 'network_or_response_failure'
            if not re.fullmatch(r'[a-z0-9_]{1,100}', safe):
                safe = 'request_failed'
            item.update(status='failed_or_uncertain', error=safe,
                        elapsedSeconds=round(time.monotonic() - started, 2))
            record['status'] = 'stopped_no_retry'
            write_json(ledger, record)
            raise TrialError(safe) from None
        write_json(ledger, record)
    record['status'] = 'complete'
    write_json(ledger, record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--expected-audio-sha256', required=True)
    parser.add_argument('--execute-approved', action='store_true')
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    if not output.is_relative_to(workspace / '.studio-data'):
        raise TrialError('private_output_required')
    request = json.loads(args.request.read_text(encoding='utf-8'))
    audio, duration, digest = prepare_audio(Path(request['audio']), args.expected_audio_sha256)
    estimate = round(duration / 60 * sum(RATES.values()), 8)
    print(json.dumps({'stage': 'preflight', 'duration': duration, 'bytes': len(audio),
                      'audioSha256': digest, 'plannedRequests': 2,
                      'estimatedUsd': estimate, 'lyricsUploaded': False,
                      'execute': args.execute_approved}), flush=True)
    if args.execute_approved:
        if os.environ.get('OPENAI_BASE_URL', '').rstrip('/') not in (
                '', 'https://api.openai.com', 'https://api.openai.com/v1'):
            raise TrialError('custom_endpoint_not_consented')
        record = run_trial(audio, duration, digest, output, os.environ.get('OPENAI_API_KEY'))
        print(json.dumps({'stage': 'complete', 'requests': len(record['attempts']),
                          'estimatedUsd': estimate}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except TrialError as error:
        print(json.dumps({'stage': 'stopped', 'error': str(error), 'retry': False}), flush=True)
        raise SystemExit(1)
