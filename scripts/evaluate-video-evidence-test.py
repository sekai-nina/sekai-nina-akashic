"""時系列判定の失敗条件と、評価データの混入防止を検証する。"""

import copy
import importlib.util
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location("video_evidence", Path(__file__).with_name("evaluate-video-evidence.py"))
ev = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ev
spec.loader.exec_module(ev)


def sample(times=(0, 1, 2), scores=None, tracks=None, label=True):
    scores = scores if scores is not None else [.6] * len(times)
    tracks = tracks if tracks is not None else ["track-1"] * len(times)
    return {"videoId": "video-1", "targetId": "person-A", "groupId": "source-1",
            "modelVersion": "synthetic", "referenceVersion": "synthetic",
            "split": "validation", "durationSec": max(times, default=0) + 10,
            "label": label, "labelSource": "synthetic",
            "frames": [{"t": t, "faces": [{"predictedEntityId": "person-A", "similarity": score,
                        "detScore": .9, "trackId": track}]} for t, score, track in zip(times, scores, tracks)]}


class EvidenceTests(unittest.TestCase):
    def evaluate(self, record):
        return ev.evaluate_video(record, ev.Policy())

    def test_isolated_spike_is_pending(self):
        result = self.evaluate(sample(times=(7.23,), scores=(.5033,), label=False))
        self.assertTrue(result["legacyAuto"])
        self.assertFalse(result["temporalAuto"])

    def test_sustained_hits_are_accepted(self):
        self.assertTrue(self.evaluate(sample())["temporalAuto"])

    def test_new_threshold_does_not_change_legacy_baseline(self):
        result = ev.evaluate_video(sample(), ev.Policy(threshold=.7))
        self.assertTrue(result["legacyAuto"])
        self.assertFalse(result["temporalAuto"])

    def test_runner_up_margin_applies_only_to_new_policy(self):
        record = sample()
        for frame in record["frames"]:
            frame["faces"][0]["runnerUpSimilarity"] = .58
        result = ev.evaluate_video(record, ev.Policy(min_margin=.05))
        self.assertTrue(result["legacyAuto"])
        self.assertFalse(result["temporalAuto"])
        for frame in record["frames"]:
            frame["faces"][0]["runnerUpSimilarity"] = .4
        self.assertTrue(ev.evaluate_video(record, ev.Policy(min_margin=.05))["temporalAuto"])

    def test_sparse_legacy_and_dense_temporal_samples_are_separate(self):
        record = sample()
        for frame in record["frames"]:
            frame["legacySample"] = False
        result = self.evaluate(record)
        self.assertFalse(result["legacyAuto"])
        self.assertTrue(result["temporalAuto"])
        for frame in record["frames"]:
            frame["legacySample"] = True
            frame["temporalSample"] = False
        result = self.evaluate(record)
        self.assertTrue(result["legacyAuto"])
        self.assertFalse(result["temporalAuto"])

    def test_dense_frames_are_not_separate_evidence(self):
        self.assertFalse(self.evaluate(sample(times=(0, .02, .04, .06)))["temporalAuto"])

    def test_evidence_does_not_depend_on_absolute_second_boundary(self):
        policy = ev.Policy(min_hits=2, min_span_sec=.5, max_gap_sec=1, evidence_bin_sec=.5)
        for times in ((0, .6), (.8, 1.4), (5.75, 6.35)):
            self.assertTrue(ev.evaluate_video(sample(times=times), policy)["temporalAuto"])
        for times in ((0, .1), (.95, 1.05)):
            self.assertFalse(ev.evaluate_video(sample(times=times), policy)["temporalAuto"])

    def test_unrelated_tracks_do_not_pool(self):
        self.assertFalse(self.evaluate(sample(tracks=("a", "b", "c")))["temporalAuto"])

    def test_untracked_hits_do_not_pool(self):
        result = self.evaluate(sample(tracks=(None, None, None)))
        self.assertFalse(result["temporalAuto"])
        self.assertEqual(result["untrackedHits"], 3)

    def test_scene_cut_breaks_support(self):
        record = sample()
        record["frames"][1]["sceneCut"] = True
        self.assertFalse(self.evaluate(record)["temporalAuto"])

    def test_large_gaps_do_not_pool(self):
        self.assertFalse(self.evaluate(sample(times=(0, 10, 20)))["temporalAuto"])

    def test_low_score_interrupts_run(self):
        self.assertFalse(self.evaluate(sample(times=(0, 1, 2, 3), scores=(.6, .3, .6, .6)))["temporalAuto"])

    def test_changed_candidate_interrupts_same_track(self):
        record = sample(times=(0, 1, 2, 3))
        record["frames"][1]["faces"][0]["predictedEntityId"] = "person-B"
        self.assertFalse(self.evaluate(record)["temporalAuto"])

    def test_low_detection_quality_does_not_count(self):
        record = sample()
        for frame in record["frames"]:
            frame["faces"][0]["detScore"] = .2
        self.assertFalse(self.evaluate(record)["legacyAuto"])
        self.assertFalse(self.evaluate(record)["temporalAuto"])

    def test_short_appearance_in_long_video_is_not_diluted(self):
        record = sample(times=(50, 51, 52))
        record["durationSec"] = 3600
        self.assertTrue(self.evaluate(record)["temporalAuto"])

    def test_unknown_labels_are_excluded(self):
        result = ev.compare([sample(label=None)], ev.Policy())
        self.assertEqual(result["splits"]["validation"]["legacy"]["labeled"], 0)
        self.assertIsNone(result["splits"]["validation"]["legacy"]["precision"])
        self.assertEqual(result["groundTruthCoverage"], {"total": 1, "labeled": 0, "unknown": 1})
        self.assertEqual(result["evaluationStatus"], "incomplete-ground-truth")

    def test_incomplete_cli_does_not_write_an_accuracy_report(self):
        import json
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "videos.jsonl"
            output = Path(folder) / "comparison.json"
            source.write_text(json.dumps(sample(label=None)) + "\n")
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("evaluate-video-evidence.py")),
                                     "--input", str(source), "--require-complete", "--output", str(output)],
                                    capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(output.exists())

    def test_reviewed_face_rejection_is_not_video_absence(self):
        # 正解ラベルは動画全体に対して外部で与える。顔1件の却下は推論しない。
        record = sample(label=None)
        record["frames"][0]["faces"][0]["status"] = "rejected"
        self.assertIsNone(self.evaluate(record)["label"])

    def test_metrics_include_lost_short_appearance(self):
        records = [sample(), sample(times=(0,), label=False), sample(times=(0,), label=True)]
        for i, record in enumerate(records):
            record["videoId"] = str(i)
        result = ev.compare(records, ev.Policy())["splits"]["validation"]
        self.assertEqual((result["legacy"]["tp"], result["legacy"]["fp"]), (2, 1))
        self.assertEqual((result["temporal"]["tp"], result["temporal"]["fp"], result["temporal"]["fn"]), (1, 0, 1))

    def test_duplicates_and_split_leaks_are_rejected(self):
        record = sample()
        with self.assertRaises(ValueError):
            ev.compare([record, record], ev.Policy())
        for field in ("groupId", "videoId"):
            second = copy.deepcopy(record)
            second.update(videoId="video-2", targetId="person-B", groupId="source-2", split="test")
            second[field] = record[field]
            with self.assertRaises(ValueError):
                ev.compare([record, second], ev.Policy())

    def test_malformed_samples_fail(self):
        for value in (float("nan"), float("inf"), True, 1.2):
            record = sample()
            record["frames"][0]["faces"][0]["similarity"] = value
            with self.assertRaises(ValueError):
                self.evaluate(record)
        record = sample()
        record["frames"][1]["t"] = 0
        with self.assertRaises(ValueError):
            self.evaluate(record)
        record = sample()
        record["frames"][0]["faces"] *= 2
        with self.assertRaises(ValueError):
            self.evaluate(record)

    def test_human_label_requires_provenance(self):
        record = sample()
        del record["labelSource"]
        with self.assertRaises(ValueError):
            self.evaluate(record)

    def test_changed_model_or_references_are_rejected(self):
        for field in ("modelVersion", "referenceVersion"):
            second = sample()
            second.update(videoId="video-2")
            second[field] = "different"
            with self.assertRaises(ValueError):
                ev.compare([sample(), second], ev.Policy())

    def test_external_label_merge_preserves_unknown_cases(self):
        record = sample(label=None)
        label = {key: value for key, value in sample(label=False).items() if key != "frames"}
        result = ev.merge_labels([record], [label])
        self.assertFalse(result[0]["label"])
        self.assertIsNone(record["label"])
        self.assertIsNone(ev.merge_labels([record], [])[0]["label"])
        with self.assertRaises(ValueError):
            ev.merge_labels([sample()], [label])
        with self.assertRaises(ValueError):
            ev.merge_labels([record], [label, label])

    def test_reported_tiktok_ground_truth_is_validation_negative(self):
        import json
        path = Path(__file__).parents[1] / "data" / "video-evidence-labels.jsonl"
        labels = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        reported = next(label for label in labels if label["videoId"] == "7709835923160173845")
        self.assertIs(reported["label"], False)
        self.assertEqual(reported["split"], "validation")
        self.assertTrue(reported["labelSource"].startswith("user-confirmed-"))


if __name__ == "__main__":
    unittest.main()
