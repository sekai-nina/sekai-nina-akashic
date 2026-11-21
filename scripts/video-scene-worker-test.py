"""長尺ワーカーの途中保存・再開・プロセス境界の回帰テスト。"""
import importlib.util
import json
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock, call

import numpy as np

spec = importlib.util.spec_from_file_location("scene_worker", Path(__file__).with_name("video-scene-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class CheckpointTests(unittest.TestCase):
    def test_incomplete_descriptor_archive_is_recomputed(self):
        trial = worker.load_trial()
        desc = trial.CompactDescriptors(2)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "descriptors.npz"
            np.savez(path, scene=desc.scene, face=desc.face, valid=desc.valid)
            self.assertIsNone(worker.restore_descriptors(path, trial, 2, 10))
            np.savez(path, scene=desc.scene, face=desc.face, valid=desc.valid, cuts=np.array([float("nan")]))
            self.assertIsNone(worker.restore_descriptors(path, trial, 2, 10))
            np.savez(path, scene=desc.scene, face=desc.face, valid=desc.valid, cuts=np.array([1.]))
            restored = worker.restore_descriptors(path, trial, 2, 10)
            self.assertEqual(restored[1], [1.])

    def test_group_is_killed_even_if_renderer_already_exited(self):
        child = Mock(pid=12345)
        child.poll.return_value = 0
        with patch.object(worker.os, "killpg") as kill, patch.object(worker.time, "monotonic", side_effect=[0, 0, 6]), patch.object(worker.time, "sleep"):
            worker.stop_process_group(child)
        self.assertEqual(kill.call_args_list, [call(12345, worker.signal.SIGTERM), call(12345, 0), call(12345, worker.signal.SIGKILL)])
        child.wait.assert_called_once()

    def test_current_hash_without_ownership_marker_is_not_adopted(self):
        task = {"id": "task", "asset": {"sourceRevision": "first", "sourceSha256": "test"}}
        with tempfile.TemporaryDirectory() as d:
            cache = Path(d)
            foreign = cache / worker.hashlib.sha256(b"task:first").hexdigest()
            foreign.mkdir()
            (foreign / "user-file").write_text("keep")
            with self.assertRaises(ValueError):
                with worker.workspace(task, cache):
                    self.fail("adopted unowned directory")
            self.assertTrue((foreign / "user-file").is_file())
            self.assertFalse((foreign / ".scene-cache").exists())

    def test_partial_download_resumes_with_range_and_rechecks_last_byte(self):
        class Response(io.BytesIO):
            status = 206
            headers = {"Content-Range": "bytes 2-5/6"}
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "source.mp4"
            path.write_bytes(b"abc")
            with patch.object(worker.OPENER, "open", return_value=Response(b"cdef")) as opened:
                worker.Api("https://example.test", "ak_test").download("asset", path, worker.time.monotonic() + 60)
            self.assertEqual(path.read_bytes(), b"abcdef")
            self.assertEqual(opened.call_args.args[0].get_header("Range"), "bytes=2-4000001")

    def test_completed_stage_is_not_recomputed(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "stage.json"
            self.assertEqual(worker.cached_json(path, lambda: [1, 2]), [1, 2])
            self.assertEqual(worker.cached_json(path, lambda: self.fail("recomputed")), [1, 2])
            self.assertEqual(list(Path(d).glob("*.tmp")), [])

    def test_failed_stage_does_not_look_completed(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "stage.json"
            with self.assertRaises(RuntimeError):
                worker.cached_json(path, lambda: (_ for _ in ()).throw(RuntimeError()))
            self.assertFalse(path.exists())

    def test_failed_job_keeps_private_cache_and_success_removes_it(self):
        task = {"id": "task", "asset": {"sourceRevision": "first", "sourceSha256": "test"}}
        with tempfile.TemporaryDirectory() as d:
            cache = Path(d) / "cache"
            with self.assertRaises(RuntimeError):
                with worker.workspace(task, cache) as root:
                    saved = root
                    (root / "source.mp4").write_bytes(b"partial")
                    raise RuntimeError()
            self.assertTrue(saved.is_dir())
            self.assertEqual(saved.stat().st_mode & 0o777, 0o700)
            with worker.workspace(task, cache) as root:
                self.assertEqual(root, saved)
                self.assertEqual((root / "source.mp4").read_bytes(), b"partial")
            self.assertFalse(saved.exists())

    def test_revision_change_uses_separate_cache(self):
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for revision in ("old", "new"):
                with self.assertRaises(RuntimeError):
                    with worker.workspace({"id": "task", "asset": {"sourceRevision": revision, "sourceSha256": "test"}}, Path(d)) as root:
                        paths.append(root)
                        raise RuntimeError()
            self.assertNotEqual(*paths)

    def test_cache_cleanup_leaves_unowned_directory_alone(self):
        with tempfile.TemporaryDirectory() as d:
            cache = Path(d)
            foreign = cache / ("a" * 64)
            foreign.mkdir()
            (foreign / "user-file").write_text("keep")
            with worker.workspace({"id": "task", "asset": {"sourceRevision": "new", "sourceSha256": "test"}}, cache):
                pass
            self.assertTrue((foreign / "user-file").is_file())

    def test_streaming_inference_resumes_after_last_complete_chunk(self):
        class FakeModel:
            calls = 0
            fail_at = 5
            def __init__(self, **kwargs):
                self.options = kwargs["sess_options"]
                self_test.assertEqual(self.options.intra_op_num_threads, 1)
            def prepare(self, **kwargs):
                pass
            def get(self, image):
                FakeModel.calls += 1
                if FakeModel.calls == FakeModel.fail_at:
                    raise RuntimeError("interrupted")
                return []
        self_test = self
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = root / "source.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=2", "-c:v", "libx264", "-threads", "1", str(source)], check=True)
            refs = root / "refs.npz"
            np.savez(refs, ids=np.array(["test"]), matrix=np.ones((1, 512), dtype=np.float32))
            checkpoint = root / "checkpoint"
            checkpoint.mkdir()
            with patch("insightface.app.FaceAnalysis", FakeModel), patch.object(worker, "CHUNK_SECONDS", 1):
                with self.assertRaises(RuntimeError):
                    worker.analyze_source(source, refs, checkpoint)
                self.assertTrue((checkpoint / "faces-000000.json").is_file())
                self.assertFalse((checkpoint / "faces-000001.json").exists())
                FakeModel.calls = 0
                FakeModel.fail_at = -1
                result = worker.analyze_source(source, refs, checkpoint)
            self.assertEqual(FakeModel.calls, 4)
            self.assertEqual(len(result["frames"]), 8)
            self.assertEqual([f["t"] for f in result["frames"]], [.12, .38, .62, .88, 1.12, 1.38, 1.62, 1.88])


if __name__ == "__main__":
    unittest.main()
