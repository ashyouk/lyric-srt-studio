import copy
import unittest
from engine.evaluate_openai_trial import analyze, edit_distance


class OfflineTrialTests(unittest.TestCase):
    def setUp(self):
        self.reference = [{'id': 'a', 'text': '歌よ', 'start': 1, 'end': 2},
                          {'id': 'b', 'text': '歌よ', 'start': 4, 'end': 5},
                          {'id': 'c', 'text': '未歌唱', 'start': 6, 'end': 7}]
        self.gpt = {'text': '歌よ歌よ', 'duration': 10, 'elapsedSeconds': 1}
        self.whisper = {'text': '歌よ歌よ', 'duration': 10, 'elapsedSeconds': 2,
                        'words': [{'text': '歌よ', 'start_time': 1.1, 'end_time': 2.1},
                                  {'text': '歌よ', 'start_time': 4.1, 'end_time': 5.1}]}

    def test_reference_times_do_not_affect_inference_or_mutate_lyrics(self):
        original = copy.deepcopy(self.reference)
        result = analyze(self.reference, self.gpt, self.whisper)
        changed = copy.deepcopy(self.reference)
        for row in changed:
            row['start'] += 30; row['end'] += 30
        shifted = analyze(changed, self.gpt, self.whisper)
        for name, variant in result['variants'].items():
            self.assertEqual(variant['lines'], shifted['variants'][name]['lines'])
            self.assertNotEqual(variant['comparison'], shifted['variants'][name]['comparison'])
            self.assertTrue(all(row['review'] for row in variant['lines']))
            self.assertIsNone(variant['lines'][-1]['start'])
        self.assertEqual(original, self.reference)

    def test_gpt_text_cannot_invent_word_times(self):
        self.whisper['words'] = []
        result = analyze(self.reference, self.gpt, self.whisper)
        self.assertEqual(result['variants']['whisper-with-gpt-check']['comparison']['placedRows'], 0)

    def test_different_acoustic_scope_rejected(self):
        self.gpt['duration'] = 20
        with self.assertRaisesRegex(ValueError, 'scope'):
            analyze(self.reference, self.gpt, self.whisper)

    def test_edit_distance_counts_substitution_insertion_deletion(self):
        self.assertEqual(edit_distance('歌詞', '歌詞'), 0)
        self.assertEqual(edit_distance('歌詞', '歌声'), 1)
        self.assertEqual(edit_distance('歌詞', '歌'), 1)
        self.assertEqual(edit_distance('歌詞', '歌詞よ'), 1)


if __name__ == '__main__':
    unittest.main()
