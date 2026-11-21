"""正解の捏造・重複混入・分割変更を防ぐための抽出テスト。"""
import copy
from pathlib import Path
import runpy
import unittest

module = runpy.run_path(str(Path(__file__).with_name("prepare-video-benchmark.py")))
prepare = module["prepare"]


def inventory(count=100):
    scores = [None, .3, .45, .55, .7]
    return {"targetId": "person-A", "items": [
        {"videoId": str(i), "assetId": f"asset-{i}", "sha256": f"hash-{i}",
         "legacyMaxSimilarity": scores[i % 5], "fileSize": 100, "durationSec": 10, "handle": "example"}
        for i in range(count)]}


def labels():
    return [{"videoId": "0", "targetId": "person-A", "groupId": "old-group", "split": "validation",
             "label": False, "labelSource": "human"}]


class SamplingTests(unittest.TestCase):
    def test_high_scores_do_not_become_ground_truth(self):
        records, summary = prepare(inventory(), labels(), 50)
        self.assertEqual(len(records), 50)
        self.assertEqual(summary["labeled"], 1)
        self.assertTrue(all(row["label"] is None for row in records if row["selection"] != "regression"))

    def test_regressions_stay_validation(self):
        records, _ = prepare(inventory(), labels(), 50)
        row = next(row for row in records if row["videoId"] == "0")
        self.assertEqual(row["split"], "validation")
        self.assertIs(row["label"], False)
        self.assertEqual(row["groupId"], "sha256:hash-0")

    def test_sampling_is_reproducible_and_order_independent(self):
        records, _ = prepare(inventory(), labels(), 50)
        reversed_inventory = inventory()
        reversed_inventory["items"].reverse()
        second, _ = prepare(reversed_inventory, labels(), 50)
        self.assertEqual(records, second)

    def test_exact_duplicates_are_not_in_both_splits(self):
        data = inventory()
        duplicate = copy.deepcopy(data["items"][0])
        duplicate["videoId"] = "duplicate"
        data["items"].append(duplicate)
        records, summary = prepare(data, labels(), 100)
        self.assertEqual(summary["uniquePopulation"], 100)
        self.assertEqual(len({row["groupId"] for row in records}), len(records))

    def test_conflicting_duplicate_labels_fail(self):
        data = inventory()
        duplicate = copy.deepcopy(data["items"][0])
        duplicate["videoId"] = "duplicate"
        data["items"].append(duplicate)
        gold = labels() + [{**labels()[0], "videoId": "duplicate", "label": True}]
        with self.assertRaises(ValueError):
            prepare(data, gold, 50)

    def test_sparse_strata_do_not_prevent_full_selection(self):
        data = inventory(30)
        for row in data["items"]:
            row["legacyMaxSimilarity"] = None
        records, _ = prepare(data, labels(), 20)
        self.assertEqual(len(records), 20)

    def test_missing_regression_fails(self):
        with self.assertRaises(ValueError):
            prepare(inventory(), [{**labels()[0], "videoId": "missing"}], 50)

    def test_selection_probability_is_recorded_for_weighting(self):
        records, _ = prepare(inventory(), labels(), 50)
        for row in records:
            if row["selection"] == "regression":
                self.assertIsNone(row["samplingProbability"])
            else:
                self.assertGreater(row["samplingProbability"], 0)
                self.assertLessEqual(row["samplingProbability"], 1)


if __name__ == "__main__":
    unittest.main()
