"""サーバー上で専用のDrive読み取り認証を作る。token/secretは出力しない。

authorize --client-env <既存サーバー設定> --credentials <0600 JSON> で認可URLを表示。
finish --credentials <同じJSON> にリダイレクトURLを標準入力する。
既存のrefresh tokenはコピーせず、専用のreadonly grantを取得する。
"""
import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import time
import urllib.parse
import urllib.request

SCOPE = "https://www.googleapis.com/auth/drive.readonly"
REDIRECT = "http://localhost"


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("authorize", "finish"))
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--client-env", type=Path)
    parser.add_argument("--listen", action="store_true", help="認可の戻り先を127.0.0.1:18080で最長15分待つ")
    args = parser.parse_args()
    if args.credentials.exists():
        raise ValueError("既存の認証ファイルを上書きしません")
    pending = args.credentials.with_suffix(".pending")
    if args.operation == "authorize":
        from dotenv import dotenv_values
        values = dotenv_values(args.client_env) if args.client_env else os.environ
        if not all(values.get(k) for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")):
            raise ValueError("サーバー側OAuth client設定が必要です")
        value = {"client_id": values["GOOGLE_CLIENT_ID"], "client_secret": values["GOOGLE_CLIENT_SECRET"],
                 "state": secrets.token_urlsafe(32), "verifier": secrets.token_urlsafe(48), "created": time.time()}
        save(pending, value)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(value["verifier"].encode()).digest()).decode().rstrip("=")
        params = {"client_id": value["client_id"], "redirect_uri": REDIRECT, "response_type": "code",
                  "scope": SCOPE, "access_type": "offline", "prompt": "consent", "state": value["state"],
                  "code_challenge": challenge, "code_challenge_method": "S256", "include_granted_scopes": "false"}
        print("https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params), flush=True)
        if not args.listen:
            return
        finished = False

        class Callback(BaseHTTPRequestHandler):
            def setup(self):
                self.request.settimeout(10)
                super().setup()

            def log_message(self, *args):
                pass  # URL内のcodeはHTTPアクセスログにも残さない。

            def do_GET(self):
                if self.path == "/":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'")
                    self.end_headers()
                    self.wfile.write(b'<!doctype html><meta charset="utf-8"><title>Drive authorization</title><h1>Drive read-only authorization</h1><p>Paste the localhost URL shown after Google consent. The code is sent directly to the processing server, not to chat.</p><form method="post" action="/finish"><input type="password" name="callback" size="70" required autocomplete="off"><button>Finish</button></form>')
                    return
                self.finish_callback("http://localhost" + self.path)

            def do_POST(self):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if self.path != "/finish" or not 0 < length <= 16_384:
                        raise ValueError("不正な入力です")
                    value = urllib.parse.parse_qs(self.rfile.read(length).decode())
                    self.finish_callback(value["callback"][0])
                except (ValueError, KeyError):
                    self.send_error(400)

            def finish_callback(self, url):
                nonlocal finished
                try:
                    complete(url, args.credentials, pending)
                    message, status = "Drive read-only authorization completed. You can close this tab.", 200
                    finished = True
                except Exception:
                    message, status = "Authorization failed. Please return to the assistant.", 400
                self.send_response(status)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(message.encode())

        deadline = time.monotonic() + 900
        with HTTPServer(("127.0.0.1", 18080), Callback) as server:
            server.timeout = 1
            for _ in range(1000):
                if finished or time.monotonic() >= deadline:
                    break
                server.handle_request()
        if not finished:
            raise TimeoutError("認可待ちの15分期限を過ぎました")
        print("Drive読み取り専用認証を保存しました（0600）", flush=True)
        return
    complete(sys.stdin.readline(16_385).strip(), args.credentials, pending)
    print("Drive読み取り専用認証を保存しました（0600）")


def complete(callback_url, credentials, pending):
    if credentials.exists():
        raise ValueError("既存の認証ファイルを上書きしません")
    info = pending.lstat()
    if pending.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("認可の一時設定の所有者または権限が不正です")
    value = json.loads(pending.read_text())
    if not 0 <= time.time() - value["created"] <= 900:
        raise ValueError("認可操作の15分期限を過ぎました")
    callback = urllib.parse.urlparse(callback_url)
    query = urllib.parse.parse_qs(callback.query)
    if (callback.scheme != "http" or callback.hostname != "localhost" or callback.path not in ("", "/") or
            query.get("state") != [value["state"]] or len(query.get("code", [])) != 1):
        raise ValueError("認可のstateまたは戻り先が一致しません")
    form = {k: value[k] for k in ("client_id", "client_secret")}
    form.update(code=query["code"][0], code_verifier=value["verifier"], redirect_uri=REDIRECT, grant_type="authorization_code")
    request = urllib.request.Request("https://oauth2.googleapis.com/token", data=urllib.parse.urlencode(form).encode())
    with urllib.request.urlopen(request, timeout=30) as response:
        tokens = json.loads(response.read(65_537))
    if set(tokens.get("scope", "").split()) != {SCOPE} or not tokens.get("refresh_token"):
        raise ValueError("読み取り専用の継続認証が得られませんでした")
    save(credentials, {"client_id": value["client_id"], "client_secret": value["client_secret"],
                            "refresh_token": tokens["refresh_token"], "scopes": [SCOPE]})
    pending.unlink()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("認証設定に失敗: " + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
