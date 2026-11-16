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
