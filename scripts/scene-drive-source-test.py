import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("drive_source", Path(__file__).with_name("scene-drive-source.py"))
drive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drive)
setup_spec = importlib.util.spec_from_file_location("setup_drive", Path(__file__).with_name("setup-scene-drive.py"))
setup = importlib.util.module_from_spec(setup_spec)
setup_spec.loader.exec_module(setup)


class DriveTests(unittest.TestCase):
    def test_cancellation_after_get_prevents_writing_received_chunk(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = drive.DriveSource(self.credentials(root))
            path = root / "source.mp4"
            active = Mock(side_effect=[None, RuntimeError("lease lost")])
            with patch.object(source, "access_token", return_value="token"), self.assertRaisesRegex(RuntimeError, "lease lost"):
                source.download("file", path, time.monotonic()+60, Mock(return_value=(206,"bytes 0-2/3",b"abc")), Mock(), active)
            self.assertEqual(path.read_bytes(), b"")

    def credentials(self, root):
        path = root / "credentials.json"
        path.write_text(json.dumps({"client_id": "client", "client_secret": "secret", "refresh_token": "refresh", "scopes": [drive.READ_SCOPE]}))
        path.chmod(0o600)
        return path

    def test_rejects_broad_or_public_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.credentials(Path(d))
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                drive.DriveSource(path)
            path.chmod(0o600)
            path.write_text(path.read_text().replace("drive.readonly", "drive"))
            with self.assertRaises(ValueError):
                drive.DriveSource(path)

    def test_validates_actual_token_scope_and_caches_only_readonly_token(self):
        with tempfile.TemporaryDirectory() as d:
            source = drive.DriveSource(self.credentials(Path(d)))
            with patch.object(source.opener, "open", return_value=io.BytesIO(json.dumps({"scope": drive.READ_SCOPE, "access_token": "token", "expires_in": 3600}).encode())) as opened:
                self.assertEqual(source.access_token(time.monotonic()+60), "token")
                self.assertEqual(source.access_token(time.monotonic()+60), "token")
                self.assertEqual(opened.call_count, 1)
                self.assertEqual(opened.call_args.args[0].full_url, "https://oauth2.googleapis.com/token")
            source.expires = 0
            with patch.object(source.opener, "open", return_value=io.BytesIO(b'{"scope":"https://www.googleapis.com/auth/drive","access_token":"broad"}')):
                with self.assertRaises(ValueError):
                    source.access_token(time.monotonic()+60)

    def test_resume_goes_direct_to_google_and_rechecks_last_byte(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = drive.DriveSource(self.credentials(root))
            path = root / "source.mp4"
            path.write_bytes(b"abc")
            fetch, reserve = Mock(return_value=(206, "bytes 2-5/6", b"cdef")), Mock()
            with patch.object(source, "access_token", return_value="google-token"):
                source.download("file-id", path, time.monotonic()+60, fetch, reserve)
            self.assertEqual(path.read_bytes(), b"abcdef")
            request = fetch.call_args.args[0]
            self.assertEqual(request.full_url, "https://www.googleapis.com/drive/v3/files/file-id?alt=media&supportsAllDrives=true")
            self.assertEqual(request.get_header("Range"), "bytes=2-4000001")
            self.assertEqual(request.get_header("Authorization"), "Bearer google-token")
            reserve.assert_called_once_with(root, 6)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_range_and_id_limits_fail_before_writing(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = drive.DriveSource(self.credentials(root))
            path = root / "source.mp4"
            with patch.object(source, "access_token", return_value="token"):
                for response in ((200, "", b"x"), (206, "bytes 0-0/20000000001", b"x"), (206, "bytes 0-2/2", b"xxx")):
                    with self.assertRaises(ValueError):
                        source.download("file", path, time.monotonic()+60, Mock(return_value=response), Mock())
                with self.assertRaises(ValueError):
                    source.download("../other", path, time.monotonic()+60, Mock(), Mock())
            self.assertEqual(path.read_bytes(), b"")

    def test_oauth_callback_is_state_bound_private_and_readonly(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            target, pending = root / "credentials.json", root / "credentials.pending"
            setup.save(pending, {"client_id": "client", "client_secret": "secret", "verifier": "verifier", "state": "state", "created": time.time()})
            with patch.object(setup.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps({"scope": drive.READ_SCOPE, "refresh_token": "new-readonly-refresh"}).encode())) as opened:
                with self.assertRaises(ValueError):
                    setup.complete("http://localhost/?state=wrong&code=code", target, pending)
                opened.assert_not_called()
                setup.complete("http://localhost/?state=state&code=code", target, pending)
                self.assertEqual(target.stat().st_mode & 0o777, 0o600)
                self.assertFalse(pending.exists())
                self.assertEqual(json.loads(target.read_text())["scopes"], [drive.READ_SCOPE])
                self.assertIn(b"code_verifier=verifier", opened.call_args.args[0].data)


if __name__ == "__main__":
    unittest.main()
