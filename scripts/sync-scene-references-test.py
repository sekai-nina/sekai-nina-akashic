import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

import numpy as np

spec = importlib.util.spec_from_file_location("sync_refs", Path(__file__).with_name("sync-scene-references.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncTests(unittest.TestCase):
    def test_continuation_skips_reference_api_only_with_recent_owned_checkpoint(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            out = root / "refs.npz"
            out.write_bytes(b"existing")
            cache = root / "cache"
            entry = cache / ("a" * 64)
            entry.mkdir(parents=True)
            (entry / ".scene-cache").touch()
            (entry / "refs.npz").touch()
            marker = entry / ".continuing"
            marker.touch()
            argv = ["sync", "--omokage-root", str(root), "--out", str(out),
                    "--continuation-cache-dir", str(cache)]
            with patch.object(sync.sys, "argv", argv), patch.dict(os.environ, {"AKASHIC_FACE_KEY": "ak_test"}), \
                    patch.object(sync, "references", return_value=[]) as fetch, \
                    patch.object(sync, "arrays", return_value={"ids": [], "negative_ids": []}), \
                    patch.object(sync, "save"), patch("builtins.print"):
                sync.main()
                fetch.assert_not_called()
                os.utime(marker, (0, 0))
                sync.main()
                self.assertEqual(fetch.call_count, 1)
                marker.touch()
                (entry / ".scene-cache").unlink()
                sync.main()
                self.assertEqual(fetch.call_count, 2)

    def test_save_is_private_atomic_and_stable_for_identical_content(self):
        values = dict(ids=np.array(["nina"]), matrix=np.ones((1, 512)),
                      negative_ids=np.array([], dtype=str), negative_matrix=np.empty((0, 512)))
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "private" / "refs.npz"
            sync.save(path, values)
            original = path.read_bytes()
            inode = path.stat().st_ino
            sync.save(path, values)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.stat().st_ino, inode)
            self.assertEqual(path.read_bytes(), original)
            values["negative_ids"] = np.array(["nina"])
            values["negative_matrix"] = np.ones((1, 512))
            sync.save(path, values)
            with np.load(path, allow_pickle=False) as saved:
                self.assertEqual(saved["negative_ids"].tolist(), ["nina"])
            self.assertEqual(list(path.parent.glob("tmp*")), [])

    def test_reference_pages_are_bounded_and_cycles_fail(self):
        opener = Mock()
        opener.open.side_effect = [io.BytesIO(json.dumps(p).encode()) for p in (
            {"items": [{"id": "a"}], "next": "cursor"}, {"items": [{"id": "b"}], "next": None})]
        with patch.object(sync.urllib.request, "build_opener", return_value=opener):
            self.assertEqual(list(sync.references("https://example.test", "ak_test")), [{"id": "a"}, {"id": "b"}])
        self.assertIn("after=cursor", opener.open.call_args.args[0].full_url)
        opener.open.side_effect = [io.BytesIO(b'{"items":[],"next":"same"}') for _ in range(2)]
        with patch.object(sync.urllib.request, "build_opener", return_value=opener), self.assertRaises(ValueError):
            list(sync.references("https://example.test", "ak_test"))
        with self.assertRaises(ValueError):
            list(sync.references("http://example.test", "ak_test"))

    def test_reference_pages_are_consumed_lazily(self):
        opener = Mock()
        opener.open.side_effect = [io.BytesIO(json.dumps(p).encode()) for p in (
            {"items": [{"id": "a"}], "next": "cursor"}, {"items": [{"id": "b"}], "next": None})]
        with patch.object(sync.urllib.request, "build_opener", return_value=opener):
            rows = sync.references("https://example.test", "ak_test")
            self.assertEqual(next(rows), {"id": "a"})
            self.assertEqual(opener.open.call_count, 1)
            self.assertEqual(list(rows), [{"id": "b"}])

    def test_positive_negative_and_incompatible_references(self):
        members = types.ModuleType("omokage.members")
        members.resolve = lambda name: types.SimpleNamespace(entity_id="nina")
        members.by_entity_id = lambda eid: eid == "nina"
        embedding = base64.b64encode(np.ones(512, dtype="<f4").tobytes()).decode()
        common = {"modelVersion": "buffalo_l@3:video1", "embedding": embedding}
        with tempfile.TemporaryDirectory() as d, patch.dict("sys.modules", {"omokage.members": members}):
            root = Path(d)
            (root / "data").mkdir()
            for name in ("refs.npz", "refs-labels.npz"):
                np.savez(root / "data" / name, names=np.array(["nina"]), embeddings=np.ones((1, 512)))
            result = sync.arrays(root, [{**common, "entityId": "nina", "negativeEntityId": "nina"},
                                       {**common, "negativeEntityId": "nina"},
                                       {**common, "modelVersion": "different", "entityId": "nina"}])
            self.assertEqual(len(result["ids"]), 3)
            self.assertEqual(len(result["negative_ids"]), 1)
            self.assertEqual(result["matrix"].shape, (3, 512))


if __name__ == "__main__":
    unittest.main()
