"""動画・顔モデルを使わず、採取位置と匿名追跡の混同防止を検証する。"""
import runpy
from pathlib import Path
import unittest

module = runpy.run_path(str(Path(__file__).with_name("collect-video-evidence.py")))
Tracker, sample_frames = module["Tracker"], module["sample_frames"]


def face(vector=(1, 0), box=(.1, .1, .3, .3)):
    return {"box": box, "embedding": vector}


class CollectionTests(unittest.TestCase):
    def test_original_sampling_is_capped_at_24(self):
        samples = sample_frames(30, 1440, .5)
        self.assertEqual(sum(flags["legacySample"] for _, flags in samples), 24)
        self.assertEqual(sum(flags["temporalSample"] for _, flags in samples), 96)
        self.assertEqual(len({index for index, _ in samples}), len(samples))

    def test_short_video_keeps_original_one_second_sampling(self):
        samples = sample_frames(30, 300, .5)
        self.assertEqual([i for i, flags in samples if flags["legacySample"]], list(range(15, 300, 30)))

    def test_subsecond_video_still_has_a_sample(self):
        samples = sample_frames(30, 3, .5)
        self.assertEqual(samples, [(0, {"legacySample": True, "temporalSample": True})])

    def test_bad_media_metadata_fails(self):
        for fps, count in ((0, 1), (float("nan"), 10), (30, 0)):
            with self.assertRaises(ValueError):
                sample_frames(fps, count, .5)

    def test_variable_fps_uses_actual_times_for_dense_samples(self):
        times = [0, .1, .2, .3, 1.0, 1.2, 1.8, 2.0]
        samples = sample_frames(4, 8, .5, times)
        self.assertEqual([index for index, flags in samples if flags["temporalSample"]], [3, 4, 6])

    def test_sequential_decode_never_seeks(self):
        class FakeCapture:
            current = -1
            def grab(self):
                self.current += 1
                return self.current < 10
            def retrieve(self):
                return True, f"frame-{self.current}"
        decoded = list(module["read_samples"](FakeCapture(), [(2, {}), (5, {}), (8, {})]))
        self.assertEqual([image for _, _, image in decoded], ["frame-2", "frame-5", "frame-8"])
        with self.assertRaises(ValueError):
            list(module["read_samples"](FakeCapture(), [(10, {})]))

    def test_same_face_keeps_track(self):
        tracker = Tracker()
        self.assertEqual(tracker.assign([face()], 0), tracker.assign([face()], .5))

    def test_same_position_different_appearance_starts_track(self):
        tracker = Tracker()
        first = tracker.assign([face()], 0)
        self.assertNotEqual(first, tracker.assign([face((0, 1))], .5))

    def test_long_gap_and_scene_cut_start_new_tracks(self):
        for t, cut in ((5, False), (.5, True)):
            tracker = Tracker()
            first = tracker.assign([face()], 0)
            self.assertNotEqual(first, tracker.assign([face()], t, cut))

    def test_one_track_is_not_assigned_to_two_faces(self):
        tracker = Tracker()
        original = tracker.assign([face()], 0)[0]
        assignments = tracker.assign([face(), face()], .5)
        self.assertEqual(len(set(assignments)), 2)
        self.assertEqual(assignments.count(original), 1)

    def test_crossing_faces_follow_appearance_not_input_order(self):
        tracker = Tracker()
        original = tracker.assign([face(), face((0, 1))], 0)
        assignments = tracker.assign([face((0, 1)), face()], .5)
        self.assertEqual(assignments, list(reversed(original)))


if __name__ == "__main__":
    unittest.main()
