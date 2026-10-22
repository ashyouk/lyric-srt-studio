"""Local song comparison. Reference video timings are used ONLY after inference.

Private requests, media, transcripts and results belong in .studio-data, not Git.
Rendered subtitle boundaries are a comparison reference, not human-scored vocals.
"""
import argparse
import copy
import json
import math
from pathlib import Path
import statistics
import time


def acoustic_windows(duration, chunk_seconds, overlap_seconds):
    """Fixed audio windows and disjoint midpoint ownership; no lyric timing input."""
    if chunk_seconds <= overlap_seconds or overlap_seconds < 0 or duration <= 0:
        raise ValueError('Require duration > 0 and chunk > overlap >= 0.')
    start = 0.
    while start < duration:
        end = min(duration, start + chunk_seconds)
        yield (start, end, start + overlap_seconds / 2 if start else 0.,
               end - overlap_seconds / 2 if end < duration else duration)
        if end >= duration:
            break
        start += chunk_seconds - overlap_seconds


def offset_owned_words(words, offset, left, right):
    """Own each overlap word once by acoustic midpoint, preserving its boundaries."""
    result = []
    for word in words:
        start, end = float(word.start) + offset, float(word.end) + offset
        if end > start and left <= (start + end) / 2 < right:
            result.append({'text': word.word, 'start_time': start, 'end_time': end,
                           'probability': float(word.probability)})
    return result


def guard_short_repetitions(canonical, recognized, estimates):
    """Abstain on short text grossly over-repeated by ASR, never move its time.

    This is a conservative experiment, not a calibrated confidence score.
    Uses supplied text and recognized text only, never reference video times.
    """
    from engine.align import normalized
    result = copy.deepcopy(estimates)
    heard = normalized(recognized)
    by_id = {row['id']: row for row in result}
    for line in canonical:
        text = normalized(line.get('alignmentText') or line['text'])
        if not text or len(text) > 3:
            continue
        expected = sum(normalized(r.get('alignmentText') or r['text']).count(text) for r in canonical)
        observed = heard.count(text)
        if observed <= max(3, expected * 3):
            continue
        row = by_id.get(line['id'])
        if row is None:
            continue
        if row.get('start') is not None:
            row['candidateStart'], row['candidateEnd'] = row['start'], row['end']
        row['start'], row['end'], row['review'] = None, None, True
        row.setdefault('reasons', []).append(
            f'短い歌詞の出現が入力では{expected}回、認識では{observed}回あり、対応が曖昧なため未配置にしました。候補付近を確認してください。')
        row.setdefault('evidence', {})['ambiguousShortRepetition'] = {'expected': expected, 'recognized': observed}
    return result


def compare_timings(reference, estimated, tolerance=.3):
    by_id = {row['id']: row for row in estimated}
    details, starts, ends = [], [], []
    for row in reference:
        estimate = by_id.get(row['id'], {})
        start, end = estimate.get('start'), estimate.get('end')
        valid = all(isinstance(t, (int, float)) and not isinstance(t, bool)
                    and math.isfinite(t) for t in [start, end])
        valid = valid and 0 <= start < end
        item = {'id': row['id'], 'text': row['text'], 'placed': valid}
        if valid:
            ds, de = start - row['start'], end - row['end']
            starts.append(abs(ds)); ends.append(abs(de))
            item.update(startDelta=round(ds, 3), endDelta=round(de, 3),
                        startWithinTolerance=abs(ds) <= tolerance + 1e-6,
                        endWithinTolerance=abs(de) <= tolerance + 1e-6,
                        bothWithinTolerance=abs(ds) <= tolerance + 1e-6 and abs(de) <= tolerance + 1e-6)
        details.append(item)
    return {'referenceKind': 'rendered-video-boundaries-not-vocal-ground-truth',
            'referenceRows': len(reference), 'placedRows': len(starts),
            'missingRows': len(reference) - len(starts), 'toleranceSeconds': tolerance,
            'startWithinTolerance': sum(x.get('startWithinTolerance', False) for x in details),
            'endWithinTolerance': sum(x.get('endWithinTolerance', False) for x in details),
            'bothWithinTolerance': sum(x.get('bothWithinTolerance', False) for x in details),
            'startMedianAbsoluteSeconds': round(statistics.median(starts), 3) if starts else None,
            'endMedianAbsoluteSeconds': round(statistics.median(ends), 3) if ends else None,
            'details': details}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--model', choices=['small', 'large-v3-turbo'], default='large-v3-turbo')
    parser.add_argument('--hint', action='store_true', help='Provide canonical lyrics as an ASR prompt')
    parser.add_argument('--chunk-seconds', type=float, default=0, help='Compare fixed overlapping audio windows')
    parser.add_argument('--overlap-seconds', type=float, default=10)
    parser.add_argument('--guard-short-repetitions', action='store_true')
    parser.add_argument('--evaluate', type=Path, help='Score an existing acoustic result without inference')
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding='utf-8'))
    if args.evaluate:
        result = json.loads(args.evaluate.read_text(encoding='utf-8'))
    else:
        from faster_whisper import WhisperModel
        from engine.align import aggregate
        import soundfile as sf
        started = time.monotonic()
        audio, sr = sf.read(request['audio'], dtype='float32')
        if sr != 16000 or audio.ndim != 1:
            raise ValueError('Benchmark audio must be 16kHz mono PCM.')
        duration = len(audio) / sr
        model = WhisperModel(args.model, device='cpu', compute_type='int8',
                             cpu_threads=4, local_files_only=True)
        # Never send the reference starts/ends to the recognizer or matcher.
        canonical = [{'id': r['id'], 'text': r['text'],
                      'alignmentText': r.get('alignmentText', r['text'])}
                     for r in request['reference']]
        windows = list(acoustic_windows(duration, args.chunk_seconds, args.overlap_seconds)) if args.chunk_seconds else [(0., duration, 0., duration)]
        words = []
        for index, (start, end, left, right) in enumerate(windows):
            segments, _ = model.transcribe(audio[round(start*sr):round(end*sr)],
                language='ja', word_timestamps=True, beam_size=5, vad_filter=False,
                condition_on_previous_text=False,
                initial_prompt='\n'.join(r['text'] for r in canonical) if args.hint else None)
            words.extend(offset_owned_words((w for s in segments for w in s.words), start, left, right))
            print(json.dumps({'window': index+1, 'total': len(windows), 'audioStart': start,
                              'audioEnd': end, 'keptWords': len(words)}), flush=True)
        recognized = ''.join(w['text'] for w in words)
        result = {'engine': f'faster-whisper-{args.model}', 'hint': args.hint,
                  'chunkSeconds': args.chunk_seconds, 'overlapSeconds': args.overlap_seconds if args.chunk_seconds else 0,
                  'elapsedSeconds': round(time.monotonic()-started, 2), 'duration': duration,
                  'lines': aggregate(canonical, words, recognized, duration),
                  'diagnostics': {'recognizedForMatchingOnly': recognized, 'wordTimings': words,
                                  'asrModel': args.model}}
    if args.guard_short_repetitions:
        result['lines'] = guard_short_repetitions(request['reference'],
            result.get('diagnostics', {}).get('recognizedForMatchingOnly', ''), result['lines'])
        result['shortRepetitionGuard'] = True
    result['comparison'] = compare_timings(request['reference'], result['lines'])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in result['comparison'].items() if k != 'details'}, ensure_ascii=False))
    print(json.dumps({'engine': result.get('engine'), 'elapsedSeconds': result.get('elapsedSeconds'),
                      'recognized': result.get('diagnostics', {}).get('recognizedForMatchingOnly')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
