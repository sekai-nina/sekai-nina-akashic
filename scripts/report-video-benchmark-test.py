"""集計の分母・ペア比較・層別重み付けを検証する。"""
from pathlib import Path
import runpy
import unittest

module = runpy.run_path(str(Path(__file__).with_name("report-video-benchmark.py")))


class ReportTests(unittest.TestCase):
    def test_empty_interval_is_not_zero(self):
        self.assertIsNone(module["wilson"](0, 0))

    def test_all_correct_is_not_certain_with_small_sample(self):
        low, high = module["wilson"](9, 9)
        self.assertGreater(low, .6)
        self.assertLess(low, .8)
        self.assertAlmostEqual(high, 1)
        low, high = module["wilson"](0, 32)
        self.assertAlmostEqual(low, 0)
        self.assertGreater(high, .05)

    def test_paired_changes_keep_new_misses_visible(self):
        cases = [{"label": False, "legacyAuto": True, "temporalAuto": False},
                 {"label": True, "legacyAuto": True, "temporalAuto": False}]
        result = module["paired_changes"](cases)
        self.assertEqual(result["negative"]["fixed"], 1)
        self.assertEqual(result["positive"]["newErrors"], 1)

    def test_sampling_weights_and_regression_exclusion(self):
        cases = [{"videoId": "a", "label": True, "legacyAuto": True},
                 {"videoId": "b", "label": False, "legacyAuto": True},
                 {"videoId": "c", "label": True, "legacyAuto": True}]
        candidates = {"a": {"selection": "stratified-random", "samplingProbability": .1},
                      "b": {"selection": "stratified-random", "samplingProbability": .5},
                      "c": {"selection": "regression", "samplingProbability": None}}
        result = module["weighted_metrics"](cases, "legacyAuto", candidates)
        self.assertEqual(result["included"], 2)
        self.assertAlmostEqual(result["precision"], 10 / 12)

    def test_policy_selection_does_not_read_test_frames_or_labels(self):
        def record(video, label, score):
            return {"videoId": video, "targetId": "person-A", "groupId": video, "split": "validation",
                    "label": label, "labelSource": "human", "durationSec": 3,
                    "modelVersion": "synthetic", "referenceVersion": "synthetic",
                    "frames": [{"t": t, "faces": [{"trackId": "a", "predictedEntityId": "person-A",
                                "similarity": score, "detScore": .9}]} for t in (0, 1, 2)]}
        records = [record("positive", True, .6), record("negative", False, .45)]
        candidates = {row["videoId"]: {"selection": "stratified-random", "samplingProbability": 1} for row in records}
        search = {"thresholds": [.4, .5], "minHits": [2], "minSpanSec": [.5], "minMargin": [0],
                  "maxGapSec": 1, "evidenceBinSec": .5, "minimumWeightedRecall": .95, "regressionsMustMatch": True}
        selected, report = module["select_policy"](records, candidates, search)
        self.assertEqual(selected.threshold, .5)
        held_out = {"split": "test", "videoId": "not-readable", "frames": object(), "label": object()}
        second, _ = module["select_policy"](records + [held_out], candidates, search)
        self.assertEqual(selected, second)
        self.assertFalse(report["testUsedForSelection"])
        search["thresholds"] = [.7]
        selected, report = module["select_policy"](records, candidates, search)
        self.assertIsNone(selected)
        self.assertEqual(report["feasibleTrials"], 0)

    def test_out_of_fold_never_trains_on_the_scored_video(self):
        import dataclasses
        records = [{"videoId": str(i), "targetId": "person-A", "groupId": f"group-{i}", "split": "validation",
                    "label": bool(i % 2), "labelSource": "human", "durationSec": 3,
                    "modelVersion": "synthetic", "referenceVersion": "synthetic",
                    "frames": [{"t": t, "faces": [{"trackId": "a", "predictedEntityId": "person-A",
                                "similarity": .6, "detScore": .9}]} for t in (0, 1, 2)]} for i in range(8)]
        candidates = {row["videoId"]: {"selection": "regression" if row["videoId"] == "0" else "stratified-random",
                                      "samplingProbability": 1} for row in records}
        training = []
        def fake_select(train, candidates, search):
            training.append({row["videoId"] for row in train})
            policy = module["evidence"].Policy(min_margin=.05)
            return policy, {"selectedPolicy": dataclasses.asdict(policy), "feasibleTrials": 1}
        function = module["out_of_fold"]
        previous = function.__globals__["select_policy"]
        function.__globals__["select_policy"] = fake_select
        try:
            result = function(records, candidates, {}, "fixed-seed", module["evidence"].Policy())
        finally:
            function.__globals__["select_policy"] = previous
        self.assertEqual(result["videos"], 7)
        self.assertEqual(len({row["videoId"] for row in result["cases"]}), 7)
        for row in result["cases"]:
            self.assertNotIn(row["videoId"], training[row["fold"]])
            self.assertTrue(row["fixedAuto"])
            self.assertFalse(row["temporalAuto"])
            self.assertEqual(row["bestSupport"]["spanSec"], 0)
        self.assertTrue(all("0" in group for group in training))


if __name__ == "__main__":
    unittest.main()
