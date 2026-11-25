"""長尺ワーカーの途中保存・再開・プロセス境界の回帰テスト。"""
import importlib.util
import json
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch, Mock, call

import numpy as np

spec = importlib.util.spec_from_file_location("scene_worker", Path(__file__).with_name("video-scene-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class CheckpointTests(unittest.TestCase):
    def test_idle_poll_does_not_sync_references(self):
        api = Mock()
        api.post.return_value = {"task": None}
        with patch.object(worker.sys, "argv", ["worker", "--sync-references"]), \
                patch.dict(worker.os.environ, {"AKASHIC_VIDEO_WORKER_KEY": "ak_test"}), \
                patch.object(worker, "Api", return_value=api), patch.object(worker.subprocess, "run") as run:
            worker.main()
        run.assert_not_called()

    def test_active_analysis_syncs_references_inside_heartbeat_lifetime(self):
        task = {"id":"task", "assetId":"asset", "leaseToken":"token", "kind":"analyze", "asset":{"fileSize":1}}
        api = Mock()
        api.download.side_effect = RuntimeError("stop after sync")
        with patch.object(worker.subprocess, "run") as run, self.assertRaisesRegex(RuntimeError, "stop after sync"):
            worker.process(api, task, None, 60, sync_references=True)
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ["systemctl", "--user", "start", "video-scenes-references.service"])

    def test_drive_actual_size_is_used_when_database_int_size_is_null(self):
        task = {"id": "task", "asset": {"sourceRevision": "rev", "sourceSha256": "a"*64,
                                          "fileSize": None, "sourceBytes": 2_200_000_000}}
        with tempfile.TemporaryDirectory() as d:
            with patch.object(worker.shutil, "disk_usage", return_value=SimpleNamespace(free=20_000_000_000)):
                with worker.workspace(task, Path(d)) as root:
                    self.assertTrue(root.is_dir())  # 20GB入力扱いの32GB予約ではなく13GB予約。
        self.assertEqual(worker.source_bytes(task), 2_200_000_000)
        del task["asset"]["sourceBytes"]
        task["asset"]["fileSize"] = 100
        self.assertEqual(worker.source_bytes(task), 100)

    def test_definitive_lease_denial_does_not_wait_for_three_heartbeats(self):
        for status in (401, 403, 404, 409):
            api, stopped, lost = Mock(), Mock(), Mock()
            stopped.wait.return_value = False
            api.post.side_effect = worker.urllib.error.HTTPError("https://example.test", status, "denied", {}, None)
            worker.maintain_lease(api, {}, stopped, lost)
            self.assertEqual(api.post.call_count, 1)
            lost.set.assert_called_once()

    def test_renderer_wait_checks_cancellation_each_second(self):
        child, active = Mock(), Mock(side_effect=[None, RuntimeError("lease lost")])
        child.wait.side_effect = subprocess.TimeoutExpired("renderer", 1)
        with self.assertRaisesRegex(RuntimeError, "lease lost"):
            worker.wait_renderer(child, worker.time.monotonic()+60, 60, active)
        child.wait.assert_called_once_with(timeout=1)

    def test_direct_source_does_not_request_video_via_vercel(self):
        with tempfile.TemporaryDirectory() as d:
            payload = b"source"
            task = {"id": "task", "assetId": "asset", "leaseToken": "token", "kind": "analyze",
                    "asset": {"fileSize": 6, "sourceRevision": "rev", "sourceSha256": worker.hashlib.sha256(payload).hexdigest(),
                              "sourceDriveFileId": "drive-file"}}
            api, direct = Mock(), Mock()
            direct.download.side_effect = lambda file_id, path, *args: path.write_bytes(payload)
            child = Mock()
            child.wait.return_value = 75
            with patch.object(worker.subprocess, "Popen", return_value=child), patch.object(worker, "stop_process_group"):
                self.assertFalse(worker.process(api, task, None, 60, Path(d), drive=direct))
            api.download.assert_not_called()
            self.assertEqual(direct.download.call_args.args[0], "drive-file")
            self.assertEqual([c.args[0] for c in api.post.call_args_list], ["heartbeat", "yield"])

    def test_uploaded_files_are_not_uploaded_again_after_yield(self):
        with tempfile.TemporaryDirectory() as d:
            payload = b"source"
            task = {"id":"task", "assetId":"asset", "leaseToken":"token", "kind":"analyze", "files":[],
                    "asset":{"fileSize":6, "sourceRevision":"rev", "sourceSha256":worker.hashlib.sha256(payload).hexdigest()}}
            api = Mock()
            api.download.side_effect = lambda asset,path,deadline,**kwargs:path.write_bytes(payload)
            api.upload.side_effect = lambda task,file,deadline:"id-"+file["slot"]
            def renderer(command, **kwargs):
                out=Path(command[command.index("--out")+1]);out.mkdir(exist_ok=True)
                files=[]
                for slot in ("S", "thumb-S"):
                    photo=out/(slot+".jpg");photo.write_bytes(b"photo")
                    files.append({"slot":slot,"path":str(photo),"mimeType":"image/jpeg","sha256":worker.digest(photo)})
                result={"duration":1,"scenes":[{"id":"scene","start":0,"end":1,"videoFileId":None,"posterFileId":"S","shots":[{"fileId":"S","time":.5}]}]}
                worker.write_json(out/"render.json",{"files":files,"result":result})
                child=Mock();child.wait.return_value=0;return child
            with patch.object(worker.subprocess,"Popen",side_effect=renderer),patch.object(worker,"stop_process_group"):
                with patch.object(worker,"slice_boundary",side_effect=[None,worker.SliceYield()]):
                    self.assertFalse(worker.process(api,task,None,60,Path(d)))
                task["files"]=[{"id":"id-S"}]
                self.assertTrue(worker.process(api,task,None,60,Path(d)))
            self.assertEqual(api.upload.call_count,2)
            self.assertEqual([c.args[1]["slot"] for c in api.upload.call_args_list],["S","thumb-S"])
            self.assertEqual([c.args[0] for c in api.post.call_args_list],["yield","complete"])
            self.assertEqual(list(Path(d).iterdir()),[])

    def test_transient_job_retries_are_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            task={"id":"task","assetId":"asset","leaseToken":"token","kind":"analyze",
                  "asset":{"fileSize":6,"sourceRevision":"rev","sourceSha256":"a"*64}}
            api=Mock()
            api.download.side_effect=worker.urllib.error.HTTPError("https://example.test",500,"temporary",{},None)
            for _ in range(3):
                self.assertFalse(worker.process(api,task,None,60,Path(d)))
            with self.assertRaises(worker.urllib.error.HTTPError):
                worker.process(api,task,None,60,Path(d))
            self.assertEqual([c.args[0] for c in api.post.call_args_list],["yield","yield","yield","fail"])

    def setUp(self):
        disk = patch.object(worker.shutil, "disk_usage", return_value=SimpleNamespace(free=100_000_000_000))
        disk.start()
        self.addCleanup(disk.stop)

    def test_disk_reservation_deducts_cached_data_and_bounds_unknown_size(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with patch.object(worker.shutil, "disk_usage", return_value=SimpleNamespace(free=20_000_000_000)):
                with self.assertRaises(ValueError):
                    worker.reserve_space(root, None)
                with (root / "source.mp4").open("wb") as f:
                    f.truncate(20_000_000_000)
                worker.reserve_space(root, 20_000_000_000)
                (root / "out").mkdir()
                with (root / "out/clip.mp4").open("wb") as f:
                    f.truncate(10_000_000_000)
                with patch.object(worker.shutil, "disk_usage", return_value=SimpleNamespace(free=2_100_000_000)):
                    worker.reserve_space(root, 20_000_000_000)

    def test_interrupted_reference_pin_does_not_leave_partial_target(self):
        with tempfile.TemporaryDirectory() as d:
            source, target = Path(d) / "input.npz", Path(d) / "refs.npz"
            source.write_bytes(b"complete")
            def broken(src, dst):
                dst.write(b"partial")
                raise OSError("interrupted")
            with patch.object(worker.shutil, "copyfileobj", side_effect=broken), self.assertRaises(OSError):
                worker.pin_references(source, target)
            self.assertFalse(target.exists())
            worker.pin_references(source, target)
            self.assertEqual(target.read_bytes(), b"complete")
            source.write_bytes(b"updated")
            worker.pin_references(source, target)
            self.assertEqual(target.read_bytes(), b"complete")

    def test_large_proxy_download_stops_before_writing_body(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "source.mp4"
            api = worker.Api("https://example.test", "ak_test")
            with patch.object(api, "source_chunk", return_value=(206, "bytes 0-3999999/9000000000", b"x")):
                with self.assertRaises(worker.SourceStagingRequired):
                    api.download("asset", path, worker.time.monotonic()+60)
            self.assertEqual(path.stat().st_size, 0)

    def test_three_hour_analysis_advances_across_sixty_bounded_slices(self):
        model = Mock()
        model.get.return_value = []
        cap = Mock()
        metadata = {worker.load_trial().cv2.CAP_PROP_FPS: 30,
                    worker.load_trial().cv2.CAP_PROP_FRAME_COUNT: 324000,
                    worker.load_trial().cv2.CAP_PROP_FRAME_WIDTH: 160,
                    worker.load_trial().cv2.CAP_PROP_FRAME_HEIGHT: 90}
        cap.get.side_effect = metadata.get
        data = bytes(160 * 90 * 3)
        def decoded(source, begin, count, step, width, height):
            yield from (data for _ in range(count))
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            refs = root / "refs.npz"
            np.savez(refs, ids=np.array(["test"]), matrix=np.ones((1, 512), np.float32),
                     negative_ids=np.array([], dtype=str), negative_matrix=np.empty((0, 512), np.float32))
            checkpoint = root / "checkpoint"
            checkpoint.mkdir()
            with patch("cv2.VideoCapture", return_value=cap), patch("insightface.app.FaceAnalysis", return_value=model), patch.object(worker, "decoded_frames", decoded), patch("builtins.print"):
                for limit in range(3, 181, 3):
                    def boundary(_):
                        if len(list(checkpoint.glob("faces-*.json"))) >= limit:
                            raise worker.SliceYield()
                    with patch.object(worker, "slice_boundary", boundary), self.assertRaises(worker.SliceYield):
                        worker.analyze_source(root / "unused.mp4", refs, checkpoint, deadline=1)
                    self.assertEqual(len(list(checkpoint.glob("faces-*.json"))), limit)
                result = worker.analyze_source(root / "unused.mp4", refs, checkpoint)
            self.assertEqual(result["duration"], 10800)
            self.assertEqual(len(result["frames"]), 21600)
            self.assertEqual(model.get.call_count, 21600)  # 完了済みコマの再推論なし。

    def test_cooperative_child_exit_retains_cache_without_marking_failed(self):
        with tempfile.TemporaryDirectory() as d:
            source_bytes = b"source"
            task = {"id":"task", "assetId":"asset", "leaseToken":"token", "kind":"analyze",
                    "asset":{"fileSize":6, "sourceRevision":"rev", "sourceSha256":worker.hashlib.sha256(source_bytes).hexdigest()}}
            api = Mock()
            api.download.side_effect = lambda asset, path, deadline, **kwargs: path.write_bytes(source_bytes)
            child = Mock()
            child.wait.return_value = 75
            with patch.object(worker.subprocess, "Popen", return_value=child), patch.object(worker, "stop_process_group"):
                self.assertFalse(worker.process(api, task, None, 60, Path(d)))
            self.assertTrue(list(Path(d).glob("*/source.mp4")))
            self.assertEqual([c.args[0] for c in api.post.call_args_list], ["yield"])

    def test_source_get_retries_transient_but_not_permission_errors(self):
        api = worker.Api("https://example.test", "ak_test")
        class Response(io.BytesIO):
            status = 206
            headers = {"Content-Range":"bytes 0-0/1"}
        req = worker.urllib.request.Request("https://example.test/source")
        with patch.object(worker.OPENER, "open", side_effect=[TimeoutError(), Response(b"x")]), patch.object(worker.time, "sleep"):
            self.assertEqual(api.source_chunk(req, worker.time.monotonic()+60)[2], b"x")
        denied = worker.urllib.error.HTTPError(req.full_url,403,"denied",{},None)
        with patch.object(worker.OPENER,"open",side_effect=denied) as opened:
            with self.assertRaises(worker.urllib.error.HTTPError):
                api.source_chunk(req,worker.time.monotonic()+60)
            self.assertEqual(opened.call_count,1)

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
                return [SimpleNamespace(det_score=.9, normed_embedding=np.ones(512, np.float32) / np.sqrt(512),
                        bbox=np.array([20, 20, 50, 60]), kps=np.array([[27, 30], [43, 30], [35, 40]]))]
        self_test = self
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = root / "source.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=2", "-c:v", "libx264", "-threads", "1", str(source)], check=True)
            refs = root / "refs.npz"
            np.savez(refs, ids=np.array(["test"]), matrix=np.ones((1, 512), dtype=np.float32),
                     negative_ids=np.array([], dtype=str), negative_matrix=np.empty((0, 512), np.float32))
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
            self.assertTrue(result["trackingVersion"])
            self.assertEqual(len({f["faces"][0]["trackId"] for f in result["frames"]}), 1)
            FakeModel.calls = 0
            with patch("insightface.app.FaceAnalysis", FakeModel), patch.object(worker, "CHUNK_SECONDS", 1):
                fresh = worker.analyze_source(source, refs)
            self.assertEqual(result, fresh)

    def test_negative_references_exclude_only_the_rejected_member(self):
        e = worker.load_evidence()
        positive = np.zeros((2, 512), np.float32)
        positive[0, :2] = [.6, .8]
        positive[1, :2] = [.8, .6]
        negative = np.zeros((1, 512), np.float32)
        negative[0, 0] = 1
        query = negative[0]
        scorer = e.Scorer(["other", worker.NINA_ID], positive, [worker.NINA_ID], negative)
        self.assertEqual(scorer.predict(query, worker.NINA_ID)["predictedEntityId"], "other")
        # 無関係なメンバーの却下を本人の負例に流用しない。
        scorer = e.Scorer(["other", worker.NINA_ID], positive, ["unknown"], negative)
        result = scorer.predict(query, worker.NINA_ID)
        self.assertEqual(result["predictedEntityId"], worker.NINA_ID)
        self.assertAlmostEqual(result["runnerUpSimilarity"], .6)


class ManifestBoundaryTests(unittest.TestCase):
    def test_last_scene_rounded_past_duration_is_clamped(self):
        # テレ東音楽祭: 終わりを 0.01 秒に丸めた 191.16 が長さ 191.1576 を超え、完了が HTTP 400 になった
        result = {"duration": 191.15763333333334, "scenes": [
            {"id": "scene-7", "start": 169.25, "end": 191.16, "videoFileId": "C7", "posterFileId": "S1",
             "shots": [{"fileId": "S1", "time": 174.25}, {"fileId": "S2", "time": 191.16}]}]}
        out = worker.clamp_manifest(result)
        scene = out["scenes"][0]
        self.assertLessEqual(scene["end"], result["duration"])
        self.assertTrue(all(scene["start"] <= s["time"] <= scene["end"] for s in scene["shots"]))
        self.assertEqual([s["fileId"] for s in scene["shots"]], ["S1", "S2"])

    def test_empty_scene_after_clamp_is_dropped(self):
        out = worker.clamp_manifest({"duration": 3.1, "scenes": [
            {"id": "a", "start": 3.2, "end": 3.4, "videoFileId": None, "posterFileId": "S1", "shots": [{"fileId": "S1", "time": 3.3}]}]})
        self.assertEqual(out["scenes"], [])

    def test_frame_at_the_very_end_falls_back_to_an_earlier_time(self):
        # 3 秒のトーク: 最後ちょうどの時刻だと ffmpeg が何も書かずに正常終了し、S0001.jpg が無くて落ちた
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "S0001.jpg"
            calls = []
            def extract(source, target, t, *rest):
                calls.append(t)
                if t < 3.0:
                    target.write_bytes(b"jpeg")
            worker.extract_frame(SimpleNamespace(extract=extract), "src.mp4", path, 3.1)
            self.assertTrue(path.is_file())
            self.assertEqual(calls[0], 3.1)
            self.assertLess(calls[-1], 3.0)

    def test_frame_that_never_appears_raises_a_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                worker.extract_frame(SimpleNamespace(extract=lambda *a: None), "src.mp4", Path(tmp) / "x.jpg", 1.0)


if __name__ == "__main__":
    unittest.main()
