"""顔ワーカーと同じ確定・却下手本を非公開NPZへ同期する（推論・DB書き込みなし）。

別サービスで AKASHIC_FACE_KEY を使う。切り抜きワーカーへ顔ワーカーの鍵は渡さない。
"""
import argparse
import base64
import json
import os
import re
from pathlib import Path
import sys
import tempfile
import time
import urllib.parse
import urllib.request

import numpy as np

VERSIONS = {"buffalo_l@1", "buffalo_l@2", "buffalo_l@3", "buffalo_l@3:video1"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def references(base, key):
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("APIのURLが不正です")
    opener = urllib.request.build_opener(NoRedirect)
    after, seen, count = None, set(), 0
    deadline = time.monotonic() + 240
    for _ in range(100):
        if time.monotonic() > deadline:
            raise TimeoutError("手本の同期時間の上限です")
        params = {"limit": 500}
        if after:
            params["after"] = after
        req = urllib.request.Request(base.rstrip("/") + "/api/v1/faces/references?" + urllib.parse.urlencode(params),
                                     headers={"Authorization": "Bearer " + key})
        with opener.open(req, timeout=30) as response:
            payload = json.loads(response.read(4_000_001))
        count += len(payload["items"])
        if count > 50_000:
            raise ValueError("手本の件数が上限を超えました")
        yield from payload["items"]
        after = payload["next"]
        if not after:
            return
        if after in seen:
            raise ValueError("手本のページが循環しています")
        seen.add(after)
    raise ValueError("手本のページ数が上限を超えました")


def arrays(root, items):
    sys.path.insert(0, str(root / "src"))
    from omokage.members import resolve, by_entity_id
    ids, vectors, negative_ids, negatives = [], [], [], []
    for filename in ("refs.npz", "refs-labels.npz"):
        with np.load(root / "data" / filename, allow_pickle=False) as saved:
            for name, vector in zip(saved["names"], saved["embeddings"], strict=True):
                member = resolve(str(name))
                if member and member.entity_id:
                    ids.append(member.entity_id)
                    vectors.append(vector)
    for item in items:
        if item["modelVersion"] not in VERSIONS or not item.get("embedding"):
            continue
        positive = item.get("entityId")
        negative = item.get("negativeEntityId") if not positive else None
        chosen = positive or negative
        if not chosen or not by_entity_id(chosen):
            continue
        vector = np.frombuffer(base64.b64decode(item["embedding"], validate=True), dtype="<f4").copy()
        if vector.shape != (512,):
            raise ValueError("手本の特徴量の次元が不正です")
        (ids if positive else negative_ids).append(chosen)
        (vectors if positive else negatives).append(vector)
    matrix = np.asarray(vectors, dtype=np.float32).reshape((-1, 512))
    negative_matrix = np.asarray(negatives, dtype=np.float32).reshape((-1, 512))
    for data in (matrix, negative_matrix):
        for start in range(0, len(data), 1024):
            chunk = data[start:start + 1024]
            if not np.isfinite(chunk).all() or np.any(np.linalg.norm(chunk, axis=1) <= 0):
                raise ValueError("手本の特徴量が不正です")
    if not len(ids):
        raise ValueError("本人確認の手本がありません")
    return dict(ids=np.asarray(ids, dtype=str), matrix=matrix,
                negative_ids=np.asarray(negative_ids, dtype=str), negative_matrix=negative_matrix)


def save(path, values):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # 同じ内容ならバイト列を変えない。ZIPの保存時刻で途中保存を無効化させない。
    if path.is_file():
        with np.load(path, allow_pickle=False) as old:
            if set(old.files) == set(values) and all(np.array_equal(old[k], v) for k, v in values.items()):
                os.chmod(path, 0o600)
                return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".npz", delete=False) as handle:
            temporary = Path(handle.name)
            np.savez(handle, **values)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--omokage-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--continuation-cache-dir", type=Path)
    args = parser.parse_args()
    if args.out.is_file() and args.continuation_cache_dir and args.continuation_cache_dir.is_dir():
        for entry in args.continuation_cache_dir.iterdir():
            marker = entry / ".continuing"
            if (not entry.is_symlink() and re.fullmatch(r"[a-f0-9]{64}", entry.name) and
                    (entry / ".scene-cache").is_file() and (entry / "refs.npz").is_file() and
                    marker.is_file() and time.time() - marker.stat().st_mtime < 86400):
                print("継続中の固定手本を再利用（同期省略）")
                return
    key = os.environ.get("AKASHIC_FACE_KEY", "")
    if not key.startswith("ak_"):
        raise ValueError("顔ワーカーの専用鍵が必要です")
    values = arrays(args.omokage_root, references(os.environ.get("AKASHIC_BASE_URL", ""), key))
    save(args.out, values)
    print(f"手本を同期: 確定・公式 {len(values['ids'])} / 却下 {len(values['negative_ids'])}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"手本の同期に失敗 ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
