import unittest
from unittest.mock import patch
from engine.align import aggregate, normalized, acoustic_boundaries, select_asr_model

class AlignmentMappingTests(unittest.TestCase):
    def test_model_choice_is_explicit_and_rejects_arbitrary_download_sources(self):
        with patch.dict("os.environ", {"LYRIC_ASR_MODEL": "small"}):
            self.assertEqual(select_asr_model({}), "small")
            self.assertEqual(select_asr_model({"asrModel": "large-v3-turbo"}), "large-v3-turbo")
        with self.assertRaises(ValueError):
            select_asr_model({"asrModel": "https://example.invalid/model"})

    def test_japanese_english_display_not_rewritten(self):
        lines = [{"id":"a","text":"星よ Hello!","alignmentText":"ほしよ Hello"}]
        words = [{"text":"ほしよ","start_time":1.2,"end_time":2},
                 {"text":"Hello","start_time":2,"end_time":3.4}]
        result = aggregate(lines, words, "ほしよ Hello", 10)
        self.assertEqual(result[0]["start"], 1.2)
        self.assertEqual(result[0]["end"], 3.4)
        self.assertEqual(lines[0]["text"], "星よ Hello!")

    def test_repetition_maps_in_sequence(self):
        lines = [{"id":str(i),"text":"Hello"} for i in range(2)]
        words = [{"text":"Hello","start_time":1,"end_time":2},
                 {"text":"Hello","start_time":8,"end_time":9}]
        result = aggregate(lines, words, "Hello Hello", 10)
        self.assertEqual([r["start"] for r in result], [1,8])

    def test_unsung_or_mismatched_row_is_not_fabricated(self):
        lines = [{"id":"a","text":"Hello"},{"id":"b","text":"Never sung"}]
        words = [{"text":"Hello","start_time":1,"end_time":2},
                 {"text":"Never sung","start_time":3,"end_time":4}]
        result = aggregate(lines, words, "Hello", 10)
        self.assertIsNone(result[1]["start"])
        self.assertEqual(result[1]["candidateStart"], 3)
        self.assertTrue(result[1]["review"])

    def test_invalid_boundary_remains_review(self):
        result = aggregate([{"id":"a","text":"Hello"}],
          [{"text":"Hello","start_time":2,"end_time":1}], "Hello", 10)
        self.assertIsNone(result[0]["start"])

    def test_punctuation_normalization_is_only_matching(self):
        self.assertEqual(normalized("ＡＢＣ！ 星、"), "abc星")

    def test_missing_row_edges_preserve_partial_evidence_without_adopting_times(self):
        cases = [
            ("赤い箱", "い箱"),
            ("Blue box", "Blue bo"),
        ]
        for text, fragment in cases:
            with self.subTest(text=text):
                row = aggregate([{"id":"a","text":text}],
                    [{"text":fragment,"start_time":1,"end_time":1.3}], fragment, 10)[0]
                self.assertIsNone(row["start"])
                self.assertIsNone(row["end"])
                self.assertEqual((row["candidateStart"],row["candidateEnd"]),(1,1.3))
                self.assertTrue(row["review"])
                self.assertTrue(any("部分候補" in reason for reason in row["reasons"]))

    def test_longer_partial_candidate_is_preserved_for_review_without_a_time_shift(self):
        row = aggregate([{"id":"a","text":"赤い箱"}],
                        [{"text":"い箱","start_time":1,"end_time":2}],"い箱",10)[0]
        self.assertEqual((row["start"],row["end"]),(1,2))
        self.assertFalse(row["evidence"]["startCharacterMatched"])
        self.assertTrue(row["evidence"]["endCharacterMatched"])
        self.assertTrue(row["review"])

    def test_old_glyph_matches_all_real_word_times_without_rewriting_input(self):
        lines = [{"id":"a","text":"小さな聲","alignmentText":"小さな聲"}]
        row = aggregate(lines,[{"text":"小さな","start_time":1,"end_time":1.4},
                               {"text":"声","start_time":1.4,"end_time":2}],"小さな声",10)[0]
        self.assertEqual((row["start"],row["end"]),(1,2))
        self.assertEqual(row["evidence"]["matchedCharacters"],4)
        self.assertEqual(lines[0]["text"],"小さな聲")
        self.assertEqual(lines[0]["alignmentText"],"小さな聲")
        self.assertTrue(row["review"])

    def test_inexact_outro_voicing_and_proper_names_are_not_guessed(self):
        self.assertNotEqual(normalized("だ"),normalized("た"))
        self.assertNotEqual(normalized("架空町"),normalized("想像村"))
        row = aggregate([{"id":"a","text":"あそこです。"}],
                        [{"text":"アソコデ","start_time":3,"end_time":4}],"アソコデ",10)[0]
        self.assertIsNone(row["start"])
        self.assertIsNone(row["end"])
        self.assertTrue(row["review"])

    def test_explicit_matching_reading_uses_full_evidence_and_keeps_display_text(self):
        lines = [{"id":"a","text":"青い箱","alignmentText":"あおいはこ"}]
        row = aggregate(lines,[{"text":"あおい","start_time":1,"end_time":1.4},
                               {"text":"はこ","start_time":1.4,"end_time":2}],"あおいはこ",10)[0]
        self.assertEqual((row["start"],row["end"]),(1,2))
        self.assertEqual(lines[0]["text"],"青い箱")
        self.assertTrue(row["review"])

    def test_short_fully_matched_row_is_not_padded_or_rejected(self):
        row = aggregate([{"id":"a","text":"箱だ"}],
                        [{"text":"箱だ","start_time":1,"end_time":1.2}],"箱だ",10)[0]
        self.assertEqual((row["start"],row["end"]),(1,1.2))
        self.assertTrue(row["review"])

    def test_real_energy_edges_are_trimmed_without_uniform_division(self):
        import numpy as np
        audio = np.concatenate([np.zeros(3200), np.ones(9600) * .1, np.zeros(3200)]).astype("float32")
        start, end = acoustic_boundaries(audio, 16000, 0, 1)
        self.assertAlmostEqual(start, .17)
        self.assertAlmostEqual(end, .83)
        self.assertEqual(acoustic_boundaries(np.zeros(16000),16000,0,1),(None,None))

if __name__ == "__main__":
    unittest.main()
