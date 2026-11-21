"""負例学習への評価動画の混入と、弱い正例の自己学習を防ぐ基本条件を検証する。"""
from pathlib import Path
import runpy
import unittest

module = runpy.run_path(str(Path(__file__).with_name("evaluate-video-negative-bank.py")))


class NegativeBankTests(unittest.TestCase):
    def test_negative_reference_must_win_by_existing_margin(self):
        self.assertTrue(module["decide"](True, .5, .54))
        self.assertFalse(module["decide"](True, .5, .56))
        self.assertTrue(module["decide"](True, .8, .6))

    def test_missing_reference_does_not_promote_or_reject(self):
        self.assertTrue(module["decide"](True, .5, None))
        self.assertFalse(module["decide"](False, .7, None))
        self.assertFalse(module["decide"](True, .3, None))

    def test_no_scored_video_is_used_for_training(self):
        rows = [{"videoId": str(i), "groupId": str(i), "selection": "stratified-random"} for i in range(20)]
        rows.append({"videoId": "regression", "groupId": "regression", "selection": "regression"})
        scored = []
        for fold in range(5):
            training, test = module["split_fold"](rows, fold, "fixed")
            self.assertFalse({r["groupId"] for r in training} & {r["groupId"] for r in test})
            self.assertIn("regression", {r["videoId"] for r in training})
            scored.extend(row["videoId"] for row in test)
        self.assertEqual(len(scored), 20)
        self.assertEqual(len(set(scored)), 20)


if __name__ == "__main__":
    unittest.main()
