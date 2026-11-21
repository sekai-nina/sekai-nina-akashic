"""試作の要件: 短い動画・小さい顔・弱い検出・分割後の区間を確認する。"""

import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location("clip_trial", Path(__file__).with_name("face-clip-trial.py"))
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


def sample(duration=400, times=(20, 20.5), similarity=.6, size=.05):
    frames = []
    desc = []
    for t in times:
        f = {"who": trial.NINA, "sim": similarity, "det": .9, "box": [.4, .4, .4 + size, .4 + size], "sharp": 100, "yaw": .1}
        frames.append({"t": t, "faces": [f]})
        desc.append({"scene": np.zeros((18, 32)), "face": np.zeros((24, 24))})
    return {"duration": duration, "frames": frames}, desc


class PlanTests(unittest.TestCase):
    def test_group_distractor_does_not_hide_supported_target(self):
        meta, desc = self.temporal()
        target = meta["frames"][0]["faces"][0]
        meta["frames"][0]["faces"].append({**target, "trackId": "distractor", "sim": .44})
        self.assertEqual(trial.selected_face(meta, 0)["trackId"], "one")
        self.assertEqual(trial.selected_face(meta, 1)["trackId"], "one")
        plan = trial.make_plan(meta, desc, [], [])
        self.assertEqual(len(plan["clips"]), 1)
        self.assertEqual(plan["uncertainFrames"], 0)

    def temporal(self, similarity=.43, times=(20, 20.5)):
        meta, desc = sample(times=times, similarity=similarity, size=.02)
        meta["trackingVersion"] = "test"
        for fr in meta["frames"]:
            fr["faces"][0].update(trackId="one", runnerUp=.30, det=.55)
        return meta, desc

    def test_temporal_keeps_small_reaction_with_two_same_person_frames(self):
        meta, desc = self.temporal()
        self.assertEqual(len(trial.make_plan(meta, desc, [], [])["clips"]), 1)

    def test_temporal_does_not_borrow_support_from_another_person(self):
        meta, desc = self.temporal()
        meta["frames"][1]["faces"][0]["trackId"] = "other-person"
        self.assertEqual(trial.make_plan(meta, desc, [], [])["clips"], [])

    def test_temporal_does_not_bridge_cut_or_gap(self):
        meta, desc = self.temporal()
        meta["frames"][1]["sceneCut"] = True
        self.assertEqual(trial.make_plan(meta, desc, [], [])["clips"], [])
        meta, desc = self.temporal(times=(20, 21))
        self.assertEqual(trial.make_plan(meta, desc, [], [])["clips"], [])

    def test_temporal_does_not_promote_competitor_or_single_weak_hit(self):
        meta, desc = self.temporal()
        for fr in meta["frames"]:
            fr["faces"][0]["runnerUp"] = .42
        self.assertEqual(trial.make_plan(meta, desc, [], [])["clips"], [])
        meta, desc = self.temporal(times=(20,))
        self.assertEqual(trial.make_plan(meta, desc, [], [])["clips"], [])

    def test_temporal_preserves_strong_brief_appearance(self):
        meta, desc = self.temporal(similarity=.6, times=(20,))
        meta["frames"][0]["faces"][0]["det"] = .8
        self.assertEqual(len(trial.make_plan(meta, desc, [], [])["clips"]), 1)

    def test_compact_descriptors_preserve_selection_without_float_copies(self):
        meta, desc = sample(times=(20, 20.5, 40, 40.5))
        compact = trial.CompactDescriptors(len(desc))
        for i, d in enumerate(desc):
            compact.set(i, d["scene"], d["face"])
        expected = trial.make_plan(meta, desc, [], [])
        actual = trial.make_plan(meta, compact, [], [])
        self.assertEqual([s["t"] for s in expected["shots"]], [s["t"] for s in actual["shots"]])
        self.assertEqual(expected["clips"], actual["clips"])
        self.assertEqual(compact.scene.dtype, np.uint8)
        self.assertEqual(compact.face.dtype, np.uint8)

    def test_short_video_has_screenshots_and_no_clips(self):
        meta, desc = sample(duration=30)
        plan = trial.make_plan(meta, desc, [], [])
        self.assertTrue(plan["shots"])
        self.assertEqual(plan["clips"], [])

    def test_small_face_is_still_a_clip_candidate(self):
        meta, desc = sample(size=.02)
        plan = trial.make_plan(meta, desc, [], [])
        self.assertEqual(len(plan["clips"]), 1)
        self.assertLessEqual(plan["clips"][0]["start"], 15)
        self.assertGreaterEqual(plan["clips"][0]["end"], 23.5)

    def test_short_video_keeps_supported_low_quality_frame(self):
        meta, desc = sample(duration=30)
        for fr in meta["frames"]:
            fr["faces"][0].update(sharp=5, det=.7)
        plan = trial.make_plan(meta, desc, [], [])
        self.assertEqual(len(plan["shots"]), 1)
        self.assertEqual(plan["clips"], [])

    def test_short_fallback_does_not_promote_weak_detection(self):
        meta, desc = sample(duration=30, times=(20,), similarity=.4)
        self.assertEqual(trial.make_plan(meta, desc, [], [])["shots"], [])

    def test_single_weak_detection_is_held_back(self):
        meta, desc = sample(times=(20,), similarity=.4)
        plan = trial.make_plan(meta, desc, [], [])
        self.assertEqual(plan["clips"], [])
        self.assertEqual(plan["uncertainFrames"], 1)

    def test_long_scene_splits_with_overlap_without_losing_hits(self):
        times = np.arange(.25, 130, .5).tolist()
        meta, desc = sample(duration=140, times=times)
        meta["duration"] = 400  # 長い動画内の、連続した 130 秒の出演。
        plan = trial.make_plan(meta, desc, [40, 80, 120], [39, 79, 119])
        clips = plan["clips"]
        self.assertGreater(len(clips), 1)
        for t in times:
            self.assertTrue(any(c["start"] <= t <= c["end"] for c in clips))
        for a, b in zip(clips, clips[1:]):
            self.assertLess(b["start"], a["end"])

    def test_silence_boundaries_extend_context(self):
        meta, desc = sample()
        plan = trial.make_plan(meta, desc, [], [14, 24])
        self.assertEqual((plan["clips"][0]["start"], plan["clips"][0]["end"]), (14, 24))

    def test_duplicate_screenshots_removed_across_time_slots(self):
        meta, desc = sample(times=(20, 20.5, 40, 40.5))
        plan = trial.make_plan(meta, desc, [], [])
        self.assertEqual(len(plan["shots"]), 1)


if __name__ == "__main__":
    unittest.main()
