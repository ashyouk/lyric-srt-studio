import unittest
from engine.sync_benchmark import compare_timings, acoustic_windows, offset_owned_words, guard_short_repetitions
from types import SimpleNamespace


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.reference = [{'id': 'a', 'text': '同じ歌詞', 'start': 1., 'end': 2.},
                          {'id': 'b', 'text': '同じ歌詞', 'start': 4., 'end': 5.}]

    def test_signed_offsets_and_repeated_rows_follow_ids(self):
        result = compare_timings(self.reference, [dict(self.reference[1]),
            {'id': 'a', 'start': .8, 'end': 2.4}])
        self.assertEqual(result['placedRows'], 2)
        self.assertEqual(result['bothWithinTolerance'], 1)
        self.assertEqual(result['startWithinTolerance'], 2)
        self.assertEqual(result['endWithinTolerance'], 1)
        self.assertEqual(result['details'][0]['startDelta'], -.2)
        self.assertEqual(result['details'][0]['endDelta'], .4)
        self.assertEqual(result['startMedianAbsoluteSeconds'], .1)

    def test_unplaced_rows_are_not_zeros_in_accuracy(self):
        result = compare_timings(self.reference, [{'id': 'a', 'start': None, 'end': None}])
        self.assertEqual(result['missingRows'], 2)
        self.assertIsNone(result['startMedianAbsoluteSeconds'])
        self.assertEqual(result['bothWithinTolerance'], 0)

    def test_invalid_intervals_do_not_count(self):
        for start, end in [(-1, 2), (2, 1), (1, 1), (float('nan'), 3),
                           (0, float('inf')), (True, 2), ('1', 2)]:
            with self.subTest(start=start, end=end):
                result = compare_timings(self.reference, [{'id': 'a', 'start': start, 'end': end}])
                self.assertEqual(result['placedRows'], 0)

    def test_zero_start_is_valid_and_reference_is_not_mutated(self):
        reference = [{'id': 'a', 'text': '歌', 'start': 0, 'end': 2}]
        result = compare_timings(reference, [{'id': 'a', 'start': 0, 'end': 2}])
        self.assertEqual(result['bothWithinTolerance'], 1)
        self.assertEqual(reference[0], {'id': 'a', 'text': '歌', 'start': 0, 'end': 2})
        self.assertIn('not-vocal-ground-truth', result['referenceKind'])

    def test_fixed_windows_own_overlap_once_and_preserve_last_tail(self):
        windows = list(acoustic_windows(55, 30, 10))
        self.assertEqual(windows, [(0,30,0,25), (20,50,25,45), (40,55,45,55)])
        self.assertEqual(list(acoustic_windows(23,30,10)), [(0,23,0,23)])
        self.assertEqual(list(acoustic_windows(50,30,10))[-1], (20,50,25,50))
        for chunk, overlap in [(10,10), (5,10), (10,-1)]:
            with self.assertRaises(ValueError):
                list(acoustic_windows(55,chunk,overlap))

    def test_midpoint_boundary_has_one_owner_without_moving_word_timing(self):
        word = SimpleNamespace(start=24,end=26,word='声',probability=.8)
        self.assertEqual(offset_owned_words([word],0,0,25), [])
        local = SimpleNamespace(start=4,end=6,word='声',probability=.8)
        result = offset_owned_words([local],20,25,45)
        self.assertEqual(result[0]['start_time'],24)
        self.assertEqual(result[0]['end_time'],26)

    def test_excess_short_repetition_abstains_and_preserves_raw_candidate(self):
        canonical = [{'id':'a','text':'なら、'}]
        estimates = [{'id':'a','start':20,'end':21,'reasons':[]}]
        result = guard_short_repetitions(canonical,'ならならならならなら',estimates)
        self.assertIsNone(result[0]['start'])
        self.assertEqual(result[0]['candidateStart'],20)
        self.assertEqual(result[0]['evidence']['ambiguousShortRepetition']['recognized'],5)
        self.assertEqual(estimates[0]['start'],20)

    def test_expected_repeated_short_lyrics_and_long_lines_are_not_rejected(self):
        canonical = [{'id':'a','text':'まだ'},{'id':'b','text':'まだ'},{'id':'c','text':'まだ踊れるか'}]
        estimates = [{'id':r['id'],'start':i*2,'end':i*2+1} for i,r in enumerate(canonical)]
        self.assertEqual(guard_short_repetitions(canonical,'まだ まだ まだ踊れるか',estimates), estimates)


if __name__ == '__main__':
    unittest.main()
