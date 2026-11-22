"""処理サーバー専用の読み取り認証でDriveを直接取得する。秘密はログへ出さない。"""
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
CHUNK = 4_000_000
MAX_SOURCE = 20_000_000_000


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class DriveSource:
    def __init__(self, credentials):
        path = Path(credentials)
        info = path.lstat()
        if path.is_symlink() or not path.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Drive認証は所有者だけが読める通常ファイルにしてください")
        self.credentials = json.loads(path.read_text())
        if self.credentials.get("scopes") != [READ_SCOPE] or not all(
                self.credentials.get(k) for k in ("client_id", "client_secret", "refresh_token")):
            raise ValueError("専用のDrive読み取り認証が必要です")
        self.opener = urllib.request.build_opener(NoRedirect)
        self.token, self.expires = None, 0

    def access_token(self, deadline):
        if self.token and time.monotonic() < self.expires:
            return self.token
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Drive取得時間の上限です")
        form = {k: self.credentials[k] for k in ("client_id", "client_secret", "refresh_token")}
        form.update(grant_type="refresh_token", scope=READ_SCOPE)
        req = urllib.request.Request("https://oauth2.googleapis.com/token", data=urllib.parse.urlencode(form).encode())
        with self.opener.open(req, timeout=min(40, remaining)) as response:
            value = json.loads(response.read(65_537))
        # Googleが返した実際のscopeも検査し、広い権限のtokenは使わない。
        if set(value.get("scope", "").split()) != {READ_SCOPE} or not value.get("access_token"):
            raise ValueError("Drive認証の権限が読み取り専用ではありません")
        self.token = value["access_token"]
        self.expires = time.monotonic() + max(0, min(3600, int(value.get("expires_in", 0))) - 60)
        return self.token

    def download(self, file_id, path, deadline, source_chunk, reserve_space, check_active=lambda: None):
        if not isinstance(file_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", file_id):
            raise ValueError("元動画のDrive IDが不正です")
        offset = max(0, (path.stat().st_size if path.exists() else 0) - 1)
        total, first = None, True
        with path.open("r+b" if path.exists() else "w+b") as handle:
            os.chmod(path, 0o600)
            handle.seek(offset)
            while total is None or offset < total:
                check_active()
                req = urllib.request.Request("https://www.googleapis.com/drive/v3/files/" + file_id + "?alt=media&supportsAllDrives=true",
                    headers={"Authorization": "Bearer " + self.access_token(deadline),
                             "Range": f"bytes={offset}-{offset + CHUNK - 1}"})
                # 同じbounded GET/retry処理を使うが、接続先はGoogleだけ。Akashicの鍵は渡さない。
                status, content_range, chunk = source_chunk(req, deadline)
                check_active()
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
                if status != 206 or not match or int(match[1]) != offset:
                    raise ValueError("Drive元動画の取得範囲が一致しません")
                current = int(match[3])
                if current > MAX_SOURCE or current <= 0 or (total is not None and total != current):
                    raise ValueError("Drive元動画の容量が上限を超えるか取得中に変わりました")
                total = current
                if first:
                    reserve_space(path.parent, total)
                    first = False
                if not chunk or len(chunk) > CHUNK or len(chunk) != int(match[2]) - offset + 1 or int(match[2]) >= total:
                    raise ValueError("Drive元動画の取得が途中で止まりました")
                handle.write(chunk)
                offset += len(chunk)
