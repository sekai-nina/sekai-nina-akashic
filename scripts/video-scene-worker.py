"""#394: Akashic の場面生成・保存範囲の書き出しワーカー。

必要なもの: ffmpeg / ffprobe、omokage と同じ Python 環境。
API キーは AKASHIC_VIDEO_WORKER_KEY、URL は AKASHIC_BASE_URL (https) で渡す。
キーは専用 member / internal の video_scene_worker だけ。ログにキー・アップロード URL は出さない。
実行例: python scripts/video-scene-worker.py --refs /path/to/refs-full.npz --discover --max-jobs 1
既定は 1 件で終了する。常駐の無限ループは作らない。
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

CHUNK = 4_000_000
MAX_FILE = 100_000_000
MAX_SOURCE = 2_000_000_000
ANALYSIS_VERSION = "stream-chunks-v1"
CHUNK_SECONDS = 60
MAX_OUTPUT = 2_000_000_000


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as handle:
        os.chmod(temporary, 0o600)
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def cached_json(path, create):
    if path and path.is_file():
        return json.loads(path.read_text())
    value = create()
    if path:
        write_json(path, value)
    return value


@contextmanager
def workspace(task, cache_dir):
    revision = task["asset"].get("sourceRevision")
    if not cache_dir or not revision or not task["asset"].get("sourceSha256"):
        with tempfile.TemporaryDirectory(prefix="akashic-scenes-") as temporary:
            yield Path(temporary)
        return
    cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(cache_dir, 0o700)
    key = hashlib.sha256(f"{task['id']}:{revision}".encode()).hexdigest()
    # 自分が作った非稼働の派生キャッシュだけを整理する。入力元・Drive は削除しない。
    entries = []
    for entry in cache_dir.iterdir():
        if entry.is_symlink() or not entry.is_dir() or not re.fullmatch(r"[a-f0-9]{64}", entry.name) or entry.name == key:
            continue
        if not (entry / ".scene-cache").is_file():
            continue
        entries.append(entry)
    entries.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for i, entry in enumerate(entries):
        if i < 2 and time.time() - entry.stat().st_mtime < 7 * 86400:
            continue
        with (entry / ".lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            shutil.rmtree(entry)
    if shutil.disk_usage(cache_dir).free < 6_000_000_000:
        raise ValueError("途中保存に必要な空き容量がありません")
    root = cache_dir / key
    if root.exists() and not (root / ".scene-cache").is_file():
        raise ValueError("自分が作ったキャッシュ以外は使用できません")
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink():
        raise ValueError("キャッシュの保存先が不正です")
    (root / ".scene-cache").touch(mode=0o600)
    os.utime(root)
    with (root / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield root
        except BaseException:
            raise
        else:
            shutil.rmtree(root)


def stop_process_group(child):
    """親が先に終了しても、同じグループの子孫を回収する。"""
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        child.wait()
        return
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        child.poll()  # leader を reap しても、子孫の存在確認は別に行う。
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            child.wait()
            return
        time.sleep(.05)
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def decoded_frames(source, start, count, step, width, height):
    """区間の先頭だけ seek し、区間内は ffmpeg で順にデコードする。"""
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-ss", str(start + step / 2),
        "-i", str(source), "-vf", f"tpad=stop_mode=clone:stop_duration=1,fps={1 / step},scale={width}:{height}",
        "-frames:v", str(count), "-an", "-f", "rawvideo", "-pix_fmt", "bgr24", "-threads", "1", "pipe:1"], stdout=subprocess.PIPE)
    try:
        for _ in range(count):
            size = width * height * 3
            data = bytearray()
            while len(data) < size:
                block = proc.stdout.read(size - len(data))
                if not block:
                    raise ValueError("動画のコマを最後まで取得できません")
                data.extend(block)
            yield data
        if proc.wait(timeout=10):
            raise ValueError("動画のデコードに失敗しました")
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def restore_descriptors(path, trial, count, duration):
    import numpy as np
    if not path or not path.is_file():
        return None
    try:
        with np.load(path, allow_pickle=False) as saved:
            cuts = saved["cuts"]
            if cuts.ndim != 1 or not np.issubdtype(cuts.dtype, np.number) or not np.isfinite(cuts).all() or np.any(cuts < 0) or np.any(cuts > duration):
                raise ValueError("画面切替の時刻が不正です")
            desc = trial.CompactDescriptors.from_arrays(saved["scene"], saved["face"], saved["valid"], count)
            return desc, cuts.tolist()
    except (OSError, ValueError, KeyError):
        print("descriptors checkpoint invalid; recomputing", flush=True)
        return None


def load_trial():
    spec = importlib.util.spec_from_file_location("face_clip_trial", Path(__file__).with_name("face-clip-trial.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def analyze_source(source, refs, checkpoint=None):
    """omokage と同じ buffalo_l と参照のコサイン類似度で動画を走査する。"""
    import cv2
    import numpy as np
    import onnxruntime as ort
    from insightface.app import FaceAnalysis

    with np.load(refs, allow_pickle=True) as archive:
        ids = archive["ids"]
        matrix = archive["matrix"].astype(np.float32)
    if matrix.ndim != 2 or matrix.shape[1] != 512 or len(ids) != len(matrix) or not len(ids) or not np.isfinite(matrix).all():
        raise ValueError("参照の特徴量の形式が違います")
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    if np.any(norms <= 0):
        raise ValueError("参照に空の特徴量があります")
    matrix /= norms
    members, inverse = np.unique(ids, return_inverse=True)
    order = np.argsort(inverse, kind="stable")
    matrix = np.ascontiguousarray(matrix[order])
    starts = np.searchsorted(inverse[order], np.arange(len(members)))
    app = None
    cap = cv2.VideoCapture(str(source))
    try:
        fps = cap.get(cv2.CAP_PROP_FPS)
        count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        if not math.isfinite(fps) or fps <= 0 or not math.isfinite(count) or count <= 0:
            raise ValueError("動画の長さを確認できません")
        duration = count / fps
        if duration > 86_400:
            raise ValueError("動画は 24 時間以内にしてください")
        width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if width <= 0 or height <= 0:
            raise ValueError("動画の大きさを確認できません")
        step = .25 if duration <= 180 else .5
        scale = min(1, 1280 / max(width, height))
        w, h = max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)
        cv2.setNumThreads(1)
        frames = []
        for begin in range(0, math.ceil(duration), CHUNK_SECONDS):
            finish = min(duration, begin + CHUNK_SECONDS)
            times = [round(begin + i * step + step / 2, 2) for i in range(math.ceil((finish - begin) / step))
                     if begin + i * step + step / 2 < duration]
            path = checkpoint / f"faces-{begin:06d}.json" if checkpoint else None
            if path and path.is_file():
                saved = json.loads(path.read_text())
                if [fr["t"] for fr in saved] != times:
                    raise ValueError("途中保存した時刻が一致しません")
                frames.extend(saved)
                print(f"faces {finish:.1f}/{duration:.1f}s cached", flush=True)
                continue
            if app is None:
                # 1 CPU の quota に大量の ORT スレッドを作ると空回りで処理が伸びる。
                options = ort.SessionOptions()
                options.intra_op_num_threads = 1
                options.inter_op_num_threads = 1
                app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"], allowed_modules=["detection", "recognition"], sess_options=options)
                app.prepare(ctx_id=-1, det_size=(640, 640))
            chunk = []
            stream = decoded_frames(source, begin, len(times), step, w, h)
            try:
                for t, data in zip(times, stream, strict=True):
                    image = np.frombuffer(data, np.uint8).reshape(h, w, 3)
                    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
                    faces = []
                    for face in app.get(image):
                        if face.det_score < .5:
                            continue
                        similarities = np.maximum.reduceat(matrix @ face.normed_embedding.astype(np.float32), starts)
                        best = int(np.argmax(similarities))
                        x1, y1, x2, y2 = map(float, face.bbox)
                        crop = gray[max(0, int(y1)):min(h, int(y2)), max(0, int(x1)):min(w, int(x2))]
                        sharp = float(cv2.Laplacian(crop, cv2.CV_64F).var()) if crop.size > 100 else 0
                        eye_mid = (face.kps[0] + face.kps[1]) / 2
                        eye_distance = float(np.linalg.norm(face.kps[1] - face.kps[0])) or 1
                        yaw = abs(float(face.kps[2][0] - eye_mid[0])) / eye_distance
                        faces.append({"who": str(members[best]), "sim": round(float(similarities[best]), 3),
                                      "box": [x1 / w, y1 / h, x2 / w, y2 / h], "det": round(float(face.det_score), 3),
                                      "sharp": round(sharp, 1), "yaw": round(yaw, 3)})
                    chunk.append({"t": t, "faces": faces})
            finally:
                stream.close()
            if path:
                write_json(path, chunk)
            frames.extend(chunk)
            print(f"faces {finish:.1f}/{duration:.1f}s saved", flush=True)
        return {"duration": duration, "width": width, "height": height, "fps": fps, "step": step, "frames": frames}
    finally:
        cap.release()


def render_local(source, target, kind, refs=None, frames=None, start=None, end=None, checkpoint=None):
    """ネットワークを使わない生成本体。保存済みの顔判定でオフライン検証もできる。"""
    trial = load_trial()
    target = target.resolve()
    target.mkdir(parents=True, exist_ok=True)
    files = []
    output_size = 0
    if checkpoint:
        identity = {"version": ANALYSIS_VERSION, "source": digest(source), "refs": digest(refs) if refs else None,
                    "frames": digest(frames) if frames else None, "kind": kind, "start": start, "end": end}
        checkpoint = checkpoint / hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        checkpoint.mkdir(parents=True, exist_ok=True, mode=0o700)
        identity_path = checkpoint / "identity.json"
        write_json(identity_path, identity)
        complete = checkpoint / "render.json"
        if complete.exists():
            saved = json.loads(complete.read_text())
            if all(Path(f["path"]).is_file() and digest(Path(f["path"])) == f.get("sha256") for f in saved["files"]):
                write_json(target / "render.json", saved)
                print("render cached", flush=True)
                return saved

    def register(slot, path, mime):
        nonlocal output_size
        if len(files) >= 1000:
            raise ValueError("場面のファイル数が 1 件あたりの上限を超えました")
        if not path.is_file() or not 0 < path.stat().st_size <= (CHUNK if mime == "image/jpeg" else MAX_FILE):
            raise ValueError("生成したファイルが容量の上限を超えました")
        output_size += path.stat().st_size
        if output_size > MAX_OUTPUT:
            raise ValueError("生成した素材の合計が 2 GB を超えました")
        record = {"slot": slot, "path": str(path), "mimeType": mime, "sha256": digest(path)}
        files.append(record)
        if checkpoint:
            write_json(checkpoint / f"media-{slot}.json", record)
        return slot

    def reusable(slot, path):
        saved = checkpoint / f"media-{slot}.json" if checkpoint else None
        return bool(saved and saved.is_file() and path.is_file() and
                    json.loads(saved.read_text()).get("sha256") == digest(path))

    def clip(slot, begin, finish):
        path = target / f"{slot}.mp4"
        if reusable(slot, path):
            return register(slot, path, "video/mp4")
        trial.command("-v", "error", "-y", "-ss", begin, "-i", source, "-t", finish - begin,
                      "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "veryfast",
                      "-crf", "22", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                      "-movflags", "+faststart", path)
        return register(slot, path, "video/mp4")

    if kind == "export":
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(source)], check=True, capture_output=True)
        duration = float(json.loads(probe.stdout)["format"]["duration"])
        if start is None or end is None or not 0 <= start < end <= duration + .05 or end - start > 90:
            raise ValueError("書き出しの範囲が不正です")
        result = {"fileId": clip("export", start, end)}
    else:
        if frames:
            meta = json.loads(frames.read_text())
        else:
            if not refs or not refs.is_file():
                raise ValueError("参照の特徴量ファイルがありません")
            meta = cached_json(checkpoint / "faces.json" if checkpoint else None, lambda: analyze_source(source, refs, checkpoint))
        print("stage descriptors", flush=True)
        import numpy as np
        descriptor_path = checkpoint / "descriptors.npz" if checkpoint else None
        saved = restore_descriptors(descriptor_path, trial, len(meta["frames"]), meta["duration"])
        if saved is not None:
            desc, cuts = saved
        else:
            desc, cuts, _ = trial.descriptors(source, meta, compact=True)
            if descriptor_path:
                temporary = descriptor_path.with_suffix(".tmp")
                with temporary.open("wb") as handle:
                    os.chmod(temporary, 0o600)
                    np.savez_compressed(handle, scene=desc.scene, face=desc.face, valid=desc.valid, cuts=np.array(cuts))
                    handle.flush()
                    os.fsync(handle.fileno())
                temporary.replace(descriptor_path)
        print("stage silence", flush=True)
        pauses = cached_json(checkpoint / "pauses.json" if checkpoint else None, lambda: trial.silence_points(source, meta["duration"]))
        plan = trial.make_plan(meta, desc, cuts, pauses)
        shots = list(plan["shots"])
        groups = [{"number": 1, "start": 0, "end": meta["duration"]}] if plan["short"] and shots else plan["clips"]
        scenes = []
        chosen = {}
        for number, group in enumerate(groups, 1):
            print(f"stage render {number}/{len(groups)}", flush=True)
            begin, finish = group["start"], group["end"]
            candidates = [s for s in shots if begin <= s["t"] <= finish]
            if not candidates:
                options = [(fr, trial.face_at(fr)) for fr in meta["frames"] if begin <= fr["t"] <= finish]
                options = [(fr, f) for fr, f in options if f is not None]
                if not options:
                    continue
                fr, f = max(options, key=lambda x: trial.quality(x[1]))
                candidates = [{"t": fr["t"], "score": trial.quality(f)}]
            candidates = sorted(sorted(candidates, key=lambda s: -s["score"])[:16], key=lambda s: s["t"])
            poster = max(candidates, key=lambda s: s["score"])
            rows = []
            for shot in candidates:
                t = shot["t"]
                if t not in chosen:
                    slot = f"S{len(chosen) + 1:04d}"
                    path = target / f"{slot}.jpg"
                    # ネイティブ画角を保ち、ブラウザが 1 応答で読める容量に収める。
                    if not reusable(slot, path):
                        trial.extract(source, path, t)
                        if path.stat().st_size > CHUNK:
                            trial.extract(source, path, t, "scale='min(2048,iw)':-2")
                    chosen[t] = register(slot, path, "image/jpeg")
                    thumb = target / f"thumb-{slot}.jpg"
                    if not reusable(f"thumb-{slot}", thumb):
                        trial.extract(source, thumb, t, "scale='min(640,iw)':-2")
                    register(f"thumb-{slot}", thumb, "image/jpeg")
                rows.append({"fileId": chosen[t], "time": t})
            scenes.append({"id": f"scene-{number}", "start": begin, "end": finish,
                           "videoFileId": None if plan["short"] else clip(f"C{number:04d}", begin, finish),
                           "posterFileId": chosen[poster["t"]], "shots": rows})
        result = {"duration": meta["duration"], "scenes": scenes}
    output = {"files": files, "result": result}
    (target / "render.json").write_text(json.dumps(output, ensure_ascii=False))
    if checkpoint:
        write_json(checkpoint / "render.json", output)
    return output


class Api:
    def __init__(self, base, key):
        parsed = urllib.parse.urlparse(base)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")):
            raise ValueError("API の接続先は https にしてください")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("API の接続先に認証情報・クエリは入れないでください")
        self.base = base.rstrip("/")
        self.key = key

    def post(self, operation, **values):
        body = json.dumps({"operation": operation, **values}).encode()
        req = urllib.request.Request(self.base + "/api/v1/video-scenes/tasks", data=body,
                                     headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"})
        with OPENER.open(req, timeout=40) as response:
            return json.load(response)

    def download(self, asset_id, path, deadline):
        total = None
        offset = path.stat().st_size if path.exists() else 0
        # 再開時にも末尾の 1 byte を再取得し、総容量・認可を現在の API で確かめる。
        offset = max(0, offset - 1)
        with path.open("r+b" if path.exists() else "w+b") as handle:
            handle.seek(offset)
            while total is None or offset < total:
                if time.monotonic() > deadline:
                    raise TimeoutError("処理時間の上限です")
                req = urllib.request.Request(self.base + "/api/v1/video-scenes/assets/" + urllib.parse.quote(asset_id) + "/source",
                                             headers={"Authorization": "Bearer " + self.key, "Range": f"bytes={offset}-{offset + CHUNK - 1}"})
                with OPENER.open(req, timeout=40) as response:
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                    if response.status != 206 or not match or int(match[1]) != offset:
                        raise ValueError("元動画の取得範囲が一致しません")
                    current_total = int(match[3])
                    if current_total > MAX_SOURCE or (total is not None and total != current_total):
                        raise ValueError("元動画の容量が上限を超えるか、取得中に変わりました")
                    total = current_total
                    chunk = response.read(CHUNK + 1)
                    if not chunk or len(chunk) > CHUNK or len(chunk) != int(match[2]) - offset + 1:
                        raise ValueError("元動画の取得が途中で止まりました")
                    handle.write(chunk)
                    offset += len(chunk)

    def upload(self, task, file, deadline):
        lease = {"taskId": task["id"], "token": task["leaseToken"]}
        init = self.post("upload", **lease, slot=file["slot"], mimeType=file["mimeType"])
        url = init["uploadUrl"]
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ("www.googleapis.com", "content.googleapis.com"):
            raise ValueError("アップロード先が Google Drive ではありません")
        path = Path(file["path"])
        total = path.stat().st_size
        # Drive の resumable PUT は 256 KiB の倍数にする。
        chunk_size = 4 * 1024 * 1024
        drive_id = None
        with path.open("rb") as handle:
            offset = 0
            while offset < total:
                if time.monotonic() > deadline:
                    raise TimeoutError("処理時間の上限です")
                data = handle.read(chunk_size)
                req = urllib.request.Request(url, data=data, method="PUT", headers={
                    "Content-Type": file["mimeType"], "Content-Range": f"bytes {offset}-{offset + len(data) - 1}/{total}",
                })
                try:
                    with OPENER.open(req, timeout=90) as response:
                        payload = json.load(response)
                        drive_id = payload["id"]
                except urllib.error.HTTPError as error:
                    if error.code != 308:
                        raise
                    # Google の 308 Resume Incomplete は redirect として追跡しない。
                    acknowledged = error.headers.get("Range", "")
                    if acknowledged != f"bytes=0-{offset + len(data) - 1}":
                        raise ValueError("アップロードの到達範囲が一致しません") from None
                offset += len(data)
        if not drive_id:
            raise ValueError("アップロードが完了しませんでした")
        self.post("uploaded", **lease, fileId=init["fileId"], driveFileId=drive_id)
        return init["fileId"]


def process(api, task, refs, timeout, cache_dir=None):
    deadline = time.monotonic() + timeout
    stopped = threading.Event()
    lost = threading.Event()
    lease = {"taskId": task["id"], "token": task["leaseToken"]}

    def heartbeat():
        failures = 0
        while not stopped.wait(45):
            try:
                api.post("heartbeat", **lease)
                failures = 0
            except Exception:
                failures += 1
                if failures >= 3:
                    lost.set()
                    return

    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        if task["asset"]["fileSize"] and task["asset"]["fileSize"] > MAX_SOURCE:
            raise ValueError("元動画は 2 GB までです")
        with workspace(task, cache_dir) as root:
            source = root / "source.mp4"
            print("stage download", flush=True)
            api.download(task["assetId"], source, deadline)
            expected_hash = task["asset"].get("sourceSha256")
            if expected_hash and digest(source) != expected_hash:
                source.unlink()
                raise ValueError("取得した元動画のチェックサムが一致しません")
            command = [sys.executable, str(Path(__file__).resolve()), "render", "--source", str(source), "--out", str(root / "out"), "--kind", task["kind"], "--checkpoint-dir", str(root / "checkpoints")]
            if refs:
                command += ["--refs", str(refs)]
            if task["kind"] == "export":
                command += ["--start", str(task["startSec"]), "--end", str(task["endSec"])]
            # CPU の使い切りを避け、処理時間にも上限を付ける。
            env = {**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
            # 子に API キーを渡す必要はない。
            env.pop("AKASHIC_VIDEO_WORKER_KEY", None)
            child = subprocess.Popen(command, env=env, start_new_session=True)
            try:
                code = child.wait(timeout=max(1, deadline - time.monotonic()))
                if code:
                    raise subprocess.CalledProcessError(code, command)
            finally:
                # timeout / 中断時は ffmpeg を含む子プロセス群を残さない。
                stop_process_group(child)
            rendered = json.loads((root / "out/render.json").read_text())
            ids = {}
            for file in rendered["files"]:
                print(f"stage upload {len(ids) + 1}/{len(rendered['files'])}", flush=True)
                if lost.is_set():
                    raise RuntimeError("処理の有効期限を更新できませんでした")
                ids[file["slot"]] = api.upload(task, file, deadline)
            result = rendered["result"]
            if task["kind"] == "export":
                result["fileId"] = ids[result["fileId"]]
            else:
                for scene in result["scenes"]:
                    scene["posterFileId"] = ids[scene["posterFileId"]]
                    if scene["videoFileId"]:
                        scene["videoFileId"] = ids[scene["videoFileId"]]
                    for shot in scene["shots"]:
                        shot["fileId"] = ids[shot["fileId"]]
            api.post("complete", **lease, result=result)
    except Exception:
        try:
            api.post("fail", **lease)
        except Exception:
            pass
        raise
    finally:
        stopped.set()
        thread.join(timeout=45)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "render":
        parser = argparse.ArgumentParser()
        parser.add_argument("--source", type=Path, required=True)
        parser.add_argument("--out", type=Path, required=True)
        parser.add_argument("--kind", choices=("analyze", "export"), required=True)
        parser.add_argument("--refs", type=Path)
        parser.add_argument("--frames", type=Path)
        parser.add_argument("--start", type=float)
        parser.add_argument("--end", type=float)
        parser.add_argument("--checkpoint-dir", type=Path)
        args = parser.parse_args(sys.argv[2:])
        render_local(args.source, args.out, args.kind, args.refs, args.frames, args.start, args.end, args.checkpoint_dir)
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refs", type=Path)
    parser.add_argument("--cache-dir", type=Path, help="途中結果の専用非公開ディレクトリ")
    parser.add_argument("--max-jobs", type=int, default=1, choices=range(1, 101))
    parser.add_argument("--job-timeout", type=int, default=7200, choices=range(60, 21601))
    parser.add_argument("--discover", action="store_true")
    parser.add_argument("--export-only", action="store_true", help="保存範囲の書き出しだけを処理する")
    args = parser.parse_args()
    if args.export_only and args.discover:
        parser.error("--export-only と --discover は同時に指定できません")
    key = os.environ.get("AKASHIC_VIDEO_WORKER_KEY", "")
    if not key.startswith("ak_"):
        parser.error("AKASHIC_VIDEO_WORKER_KEY を設定してください")
    api = Api(os.environ.get("AKASHIC_BASE_URL", ""), key)
    failures = 0
    for _ in range(args.max_jobs):
        task = api.post("claim", **({"kind": "export"} if args.export_only else {}))["task"]
        if not task and args.discover:
            api.post("discover")
            task = api.post("claim")["task"]
        if not task:
            print("待っている動画はありません", flush=True)
            break
        print(f"{task['id']}: {task['kind']} を処理", flush=True)
        try:
            process(api, task, args.refs, args.job_timeout, args.cache_dir)
            print(f"{task['id']}: 完了", flush=True)
        except Exception as error:
            failures += 1
            # URL・認証ヘッダが含まれうる例外本文をログに出さない。
            print(f"{task['id']}: 失敗 ({type(error).__name__})", file=sys.stderr, flush=True)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
