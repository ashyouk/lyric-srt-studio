"""Offline comparison only. No credentials or network; canonical lyrics stay local."""
import argparse
import json
from pathlib import Path
from engine.align import aggregate, normalized
from engine.sync_benchmark import compare_timings


def edit_distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def recognition_comparison(reference, text):
    canonical = normalized(''.join(row['text'] for row in reference))
    heard = normalized(text)
    edits = edit_distance(canonical, heard)
    return {'referenceKind': 'transcribed-video-text-not-human-vocal-ground-truth',
            'referenceCharacters': len(canonical), 'recognizedCharacters': len(heard),
            'characterEdits': edits, 'characterEditRatio': round(edits / max(1, len(canonical)), 4),
            'note': 'Normalized spelling-sensitive comparison, not timing accuracy or confidence.'}


def analyze(reference, gpt, whisper):
    if gpt['duration'] != whisper['duration']:
        raise ValueError('Mismatched acoustic scope.')
    duration = whisper['duration']
    # Construct the aligner input without reference times. Reference timing is
    # passed ONLY to compare_timings after the acoustic candidates are complete.
    canonical = [{'id': row['id'], 'text': row['text'],
                  'alignmentText': row.get('alignmentText') or row['text']}
                 for row in reference]
    if len({row['id'] for row in canonical}) != len(canonical):
        raise ValueError('Duplicate canonical IDs.')
    variants = {}
    for name, recognized, elapsed in [
        ('whisper-alone', whisper['text'], whisper['elapsedSeconds']),
        ('whisper-with-gpt-check', gpt['text'], gpt['elapsedSeconds'] + whisper['elapsedSeconds']),
    ]:
        lines = aggregate(canonical, whisper['words'], recognized, duration)
        variants[name] = {'engine': 'openai-' + name, 'duration': duration,
                          'elapsedSeconds': round(elapsed, 2), 'lines': lines,
                          'diagnostics': {'recognizedForMatchingOnly': recognized,
                                          'wordTimings': whisper['words'],
                                          'asrModel': 'whisper-1',
                                          'agreementModel': 'gpt-transcribe' if name.endswith('check') else 'whisper-1',
                                          'referenceTimesUsedForInference': False},
                          'comparison': compare_timings(reference, lines)}
    recognition = {name: recognition_comparison(reference, data['text'])
                   for name, data in [('gpt-transcribe', gpt), ('whisper-1', whisper)]}
    return {'recognition': recognition, 'variants': variants}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', type=Path)
    parser.add_argument('trial_directory', type=Path)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding='utf-8'))
    folder = args.trial_directory
    attempt = json.loads((folder / 'attempt.json').read_text(encoding='utf-8'))
    if attempt['status'] != 'complete':
        raise ValueError('Trial did not complete; do not fabricate missing results.')
    gpt = json.loads((folder / 'gpt-transcribe.json').read_text(encoding='utf-8'))
    whisper = json.loads((folder / 'whisper-1.json').read_text(encoding='utf-8'))
    result = analyze(request['reference'], gpt, whisper)
    for name, variant in result['variants'].items():
        (folder / (name + '.json')).write_text(json.dumps(variant, ensure_ascii=False, indent=2), encoding='utf-8')
    (folder / 'comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    summary = {'recognition': result['recognition'], 'variants': {
        name: {key: value for key, value in variant['comparison'].items() if key != 'details'}
        for name, variant in result['variants'].items()}}
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
