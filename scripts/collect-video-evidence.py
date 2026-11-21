"""既存の顔認識ソフトの評価用スコアを採取する。本番・ネットワークへの書き込みはしない。

必要な環境: omokage の Python（numpy / OpenCV / InsightFace / onnxruntime）。
正解はユーザー提供の動画単位ラベルだけを使い、登場区間の手入力は不要。
"""
from __future__ import annotations

import argparse
import base64
import bisect
import hashlib
import importlib.metadata
import inspect
import json
import math
import os
from pathlib import Path
import sys
import time
import subprocess
from concurrent.futures import ProcessPoolExecutor, as_completed
import multiprocessing

# 数値ライブラリを読み込む前に並列度を抑える。
for name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(name, "2")


def sample_frames(fps, count, step, timestamps=None):
    """本番の最大24コマと、密な時間サンプルを同じ動画フレーム番号にまとめる。"""
    if not math.isfinite(fps) or fps <= 0 or count < 1 or step <= 0:
        raise ValueError("動画の fps / コマ数 / 採取間隔が不正")
    duration = count / fps
    legacy_step = max(1.0, duration / 24)
    frames = {}
    for kind, interval, limit in (("legacySample", legacy_step, 24), ("temporalSample", step, 10000)):
        t = interval / 2
        n = 0
        while t < duration and n < limit:
            index = min(bisect.bisect_left(timestamps, t) if timestamps is not None and kind == "temporalSample"
                        else int(t * fps), count - 1)
            frames.setdefault(index, {"legacySample": False, "temporalSample": False})[kind] = True
            n += 1
            t = interval / 2 + n * interval
        if n == 0:
            frames.setdefault(0, {"legacySample": False, "temporalSample": False})[kind] = True
        if t < duration:
            raise ValueError("採取するコマが上限を超えています")
    return sorted(frames.items())


def frame_timestamps(source):
    """可変fpsでも正しい時刻を使う。動画や顔画像を外部へ送らない。"""
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                             "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", str(source)],
                            capture_output=True, check=True, timeout=60)
    stamps = [float(line.split(",")[0]) for line in result.stdout.decode().splitlines() if line.strip()]
    if not stamps or len(stamps) > 100000 or any(not math.isfinite(t) for t in stamps):
        raise ValueError("フレームの実時刻を取得できません")
    if any(b <= a for a, b in zip(stamps, stamps[1:])):
        raise ValueError("フレームの実時刻が昇順になっていません")
    start = stamps[0]
    return [t - start for t in stamps]


def read_samples(cap, samples):
    """可変fpsで失敗するランダムシークを使わず、実フレーム番号を順に読む。"""
    current = -1
    for index, flags in samples:
        while current < index:
            if not cap.grab():
                raise ValueError(f"コマ {current + 1} のデコードに失敗")
            current += 1
        ok, image = cap.retrieve()
        if not ok or image is None:
            raise ValueError(f"コマ {index} の読み出しに失敗")
        yield index, flags, image


def box_iou(a, b):
    area = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    denominator = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - area
    return area / denominator if denominator > 0 else 0


class Tracker:
    """推定メンバー名を使わず、位置と特徴量の連続性で匿名IDを対応付ける。"""
    def __init__(self):
        self.tracks = {}
        self.next_id = 1

    def assign(self, faces, t, cut=False):
        if cut:
            self.tracks.clear()
        self.tracks = {key: value for key, value in self.tracks.items() if t - value["t"] <= 1.1}
        options = []
        for i, face in enumerate(faces):
            for key, track in self.tracks.items():
                overlap = box_iou(face["box"], track["box"])
                appearance = float(sum(a * b for a, b in zip(face["embedding"], track["embedding"])))
                if overlap >= .1 and appearance >= .6:
                    options.append((appearance + overlap, i, key))
        used_faces, used_tracks, assignments = set(), set(), {}
        for _, i, key in sorted(options, reverse=True):
            if i not in used_faces and key not in used_tracks:
                assignments[i] = key
                used_faces.add(i)
                used_tracks.add(key)
        for i, face in enumerate(faces):
            if i not in assignments:
                assignments[i] = f"track-{self.next_id}"
                self.next_id += 1
            key = assignments[i]
            self.tracks[key] = {"t": t, "box": face["box"], "embedding": face["embedding"]}
        return [assignments[i] for i in range(len(faces))]


def load_references(root, folder, excluded):
    import numpy as np
    sys.path.insert(0, str(root / "src"))
    from omokage.members import resolve, by_entity_id
    ids, vectors, negatives, negative_vectors = [], [], [], []
    for filename in ("refs.npz", "refs-labels.npz"):
        with np.load(root / "data" / filename, allow_pickle=False) as archive:
            for i, name in enumerate(archive["names"]):
                if "assets" in archive.files and str(archive["assets"][i]) in excluded:
                    continue
                member = resolve(str(name))
                if member and member.entity_id:
                    ids.append(member.entity_id)
                    vectors.append(archive["embeddings"][i])
    for line in (folder / "references.jsonl").read_text().splitlines():
        item = json.loads(line)
        if item["assetId"] in excluded:
            raise ValueError("評価対象の顔が参照に混ざっています")
        positive = item["confirmedEntityId"]
        negative = item["predictedEntityId"] if item["status"] == "rejected" and not positive else None
        chosen = positive or negative
        if not chosen or not by_entity_id(chosen):
            continue
        vector = np.frombuffer(base64.b64decode(item["embedding"], validate=True), dtype="<f4").copy()
        if positive:
            ids.append(chosen)
            vectors.append(vector)
        else:
            negatives.append(chosen)
            negative_vectors.append(vector)
    matrix = np.asarray(vectors, dtype=np.float32)
    negative_matrix = np.asarray(negative_vectors, dtype=np.float32).reshape((-1, 512))
    for array in (matrix, negative_matrix):
        if array.ndim != 2 or array.shape[1] != 512 or not np.isfinite(array).all():
            raise ValueError("参照の形式が不正")
        if len(array) and np.any(np.abs(np.linalg.norm(array, axis=1) - 1) > .01):
            raise ValueError("参照の特徴量が正規化されていません")
    fingerprint = hashlib.sha256()
    for names, array in ((ids, matrix), (negatives, negative_matrix)):
        fingerprint.update(json.dumps(names).encode())
        fingerprint.update(array.astype("<f4").tobytes())
    return Scorer(ids, matrix, negatives, negative_matrix), fingerprint.hexdigest()


class Scorer:
    def __init__(self, ids, matrix, negative_ids, negative_matrix):
        import numpy as np
        self.members, self.matrix, self.starts = self.group(ids, matrix)
        members, self.negative_matrix, self.negative_starts = self.group(negative_ids, negative_matrix)
        self.negative_members = members
        index = {str(member): i for i, member in enumerate(self.members)}
        self.negative_positions = [(i, index[str(member)]) for i, member in enumerate(members) if str(member) in index]

    @staticmethod
    def group(ids, matrix):
        import numpy as np
        members, inverse = np.unique(np.asarray(ids, dtype=str), return_inverse=True)
        order = np.argsort(inverse, kind="stable")
        starts = np.searchsorted(inverse[order], np.arange(len(members)))
        return members, np.ascontiguousarray(matrix[order]), starts

    def predict(self, embedding, target):
        import numpy as np
        scores = np.maximum.reduceat(self.matrix @ embedding, self.starts)
        original = scores.copy()
        if len(self.negative_starts):
            negative = np.maximum.reduceat(self.negative_matrix @ embedding, self.negative_starts)
            for i, position in self.negative_positions:
                if negative[i] > scores[position] + .05:
                    scores[position] = -np.inf
        finite = np.flatnonzero(np.isfinite(scores))
        if not len(finite):
            return None
        ranking = finite[np.argsort(scores[finite])]
        best = ranking[-1]
        next_score = float(scores[ranking[-2]]) if len(ranking) > 1 else None
        target_positions = np.flatnonzero(self.members == target)
        return {"predictedEntityId": str(self.members[best]), "similarity": float(scores[best]),
                "runnerUpSimilarity": next_score,
                "targetPositiveSimilarity": float(original[target_positions[0]]) if len(target_positions) else None}


def collect(source, label, scorer, model, reference_version, step, deadline):
    import cv2
    import numpy as np
    cap = cv2.VideoCapture(str(source))
    frames, previous = [], None
    tracker = Tracker()
    try:
        fps, count = cap.get(cv2.CAP_PROP_FPS), int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = count / fps if fps > 0 else 0
        if not 0 < duration <= 600:
            raise ValueError("評価動画は10分以内にしてください")
        timestamps = frame_timestamps(source)
        if len(timestamps) != count:
            raise ValueError("フレーム総数がデコーダーと一致しません")
        samples = sample_frames(fps, count, step, timestamps)
        for n, (index, flags, image) in enumerate(read_samples(cap, samples), 1):
            if time.monotonic() > deadline:
                raise TimeoutError("採取の制限時間を超えました")
            h, w = image.shape[:2]
            if max(h, w) > 1280:
                scale = 1280 / max(h, w)
                image = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            h, w = image.shape[:2]
            thumbnail = cv2.resize(image, (32, 32)).astype(np.float32)
            cut = previous is not None and float(np.abs(thumbnail - previous).mean()) > 55
            previous = thumbnail
            detected = []
            for face in sorted(model.get(image), key=lambda f: -f.det_score)[:100]:
                if face.det_score < .5:
                    continue
                box = np.clip(np.asarray(face.bbox) / [w, h, w, h], 0, 1).tolist()
                if box[0] >= box[2] or box[1] >= box[3]:
                    continue
                detected.append({"box": box, "embedding": face.normed_embedding.astype(np.float32),
                                 "detScore": min(1.0, float(face.det_score))})
            t = timestamps[index]
            tracks = tracker.assign(detected, t, cut)
            faces = []
            for face, track in zip(detected, tracks):
                prediction = scorer.predict(face["embedding"], label["targetId"])
                if prediction is not None:
                    faces.append({**prediction, "detScore": face["detScore"], "trackId": track, "box": face["box"]})
            frames.append({"t": t, "sceneCut": cut, **flags, "faces": faces})
            if n % 25 == 0 or n == len(samples):
                print(f"動画 {label['videoId']}: {n}/{len(samples)} コマ", flush=True)
        return {**{key: label[key] for key in ("videoId", "targetId", "groupId", "split", "label", "labelSource")},
                "modelVersion": "buffalo_l@3", "referenceVersion": reference_version,
                "durationSec": duration, "temporalStepSec": step,
                "samplingVersion": "sequential-actual-pts@1",
                "trackingVersion": "anonymous-iou0.1-cos0.6-gap1.1-cut55@1", "frames": frames}
    finally:
        cap.release()


_WORKER = None


def create_model(recognition_provider="cpu", cache_root=None, detection_provider="cpu"):
    import warnings
    import onnxruntime as ort
    from insightface.app import FaceAnalysis
    warnings.filterwarnings("ignore", category=FutureWarning)
    session = ort.SessionOptions()
    session.intra_op_num_threads = 2
    session.inter_op_num_threads = 1
    model = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"], sess_options=session,
                         allowed_modules=["detection", "recognition"])
    model.prepare(ctx_id=-1, det_size=(640, 640))
    if recognition_provider == "coreml":
        if "CoreMLExecutionProvider" not in ort.get_available_providers():
            raise ValueError("この環境にはCoreMLがありません")
        recognition = model.models["recognition"]
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        batch_dimension = recognition.session.get_inputs()[0].shape[0]
        if isinstance(batch_dimension, str):
            options.add_free_dimension_override_by_name(batch_dimension, 1)
        provider_options = {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL", "RequireStaticInputShapes": "1"}
        if cache_root:
            provider_options["ModelCacheDirectory"] = str(cache_root.resolve())
        recognition.session = ort.InferenceSession(recognition.model_file, sess_options=options,
            providers=[("CoreMLExecutionProvider", provider_options), "CPUExecutionProvider"])
        if recognition.session.get_providers()[0] != "CoreMLExecutionProvider":
            raise ValueError("CoreMLの初期化に失敗しました")
    if detection_provider == "coreml":
        if "CoreMLExecutionProvider" not in ort.get_available_providers():
            raise ValueError("この環境にはCoreMLがありません")
        detection = model.det_model
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        for dimension, value in zip(detection.session.get_inputs()[0].shape, (1, 3, 640, 640)):
            if isinstance(dimension, str):
                options.add_free_dimension_override_by_name(dimension, value)
        provider_options = {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL", "RequireStaticInputShapes": "1"}
        if cache_root:
            provider_options["ModelCacheDirectory"] = str((cache_root.parent / "coreml-cache-det").resolve())
        detection.session = ort.InferenceSession(detection.model_file, sess_options=options,
            providers=[("CoreMLExecutionProvider", provider_options), "CPUExecutionProvider"])
        if detection.session.get_providers()[0] != "CoreMLExecutionProvider":
            raise ValueError("CoreMLの顔検出の初期化に失敗しました")
    return model


def initialize_worker(root, folder, excluded, expected_version, recognition_provider, detection_provider):
    global _WORKER
    scorer, version = load_references(root, folder, excluded)
    if version != expected_version:
        raise ValueError("走査中に参照が変わりました")
    _WORKER = scorer, create_model(recognition_provider, folder / "coreml-cache-all", detection_provider), version


def collect_job(source, label, step, deadline):
    scorer, model, version = _WORKER
    return collect(source, label, scorer, model, version, step, deadline)


def atomic_json(filename, value):
    temporary = filename.with_suffix(filename.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    temporary.chmod(0o600)
    temporary.replace(filename)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--omokage-root", type=Path, required=True)
    parser.add_argument("--folder", type=Path, default=Path("reports/video-evidence"))
    parser.add_argument("--labels", type=Path, default=Path("data/video-evidence-labels.jsonl"))
    parser.add_argument("--step", type=float, default=.5)
    parser.add_argument("--timeout-sec", type=float, default=900)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--recognition-provider", choices=("cpu", "coreml"), default="cpu")
    parser.add_argument("--detection-provider", choices=("cpu", "coreml"), default="cpu")
    args = parser.parse_args()
    max_workers = min(8, max(1, (os.cpu_count() or 2) - 2))
    if not .1 <= args.step <= 1 or not 1 <= args.timeout_sec <= 3600 or not 1 <= args.workers <= max_workers:
        parser.error(f"step は0.1〜1秒、timeout は1〜3600秒、workers は1〜{max_workers}にする")
    manifest = json.loads((args.folder / "manifest.json").read_text())
    if hashlib.sha256((args.folder / "references.jsonl").read_bytes()).hexdigest() != manifest["referencesSha256"]:
        raise ValueError("参照ファイルのハッシュが一致しません")
    labels = [json.loads(line) for line in args.labels.read_text().splitlines() if line.strip()]
    if len({(label["videoId"], label["targetId"]) for label in labels}) != len(labels):
        raise ValueError("評価対象が重複しています")
    candidates_file = args.folder / "candidates.jsonl"
    if candidates_file.exists():
        candidates = {row["videoId"]: row for row in
                      (json.loads(line) for line in candidates_file.read_text().splitlines() if line.strip())}
        for label in labels:
            candidate = candidates[label["videoId"]]
            if any(candidate[key] != label[key] for key in ("targetId", "groupId", "split")):
                raise ValueError("正解ファイルで評価対象や分割が変わっています")
        supplied = {label["videoId"]: label for label in labels}
        labels = [{**candidate, **supplied.get(video, {})} for video, candidate in candidates.items()]
    sources = {video["videoId"]: video for video in manifest["videos"]}
    if any(label["videoId"] not in sources for label in labels):
        raise ValueError("未取得の評価動画があります")
    _, version = load_references(args.omokage_root, args.folder, set(manifest["excludedAssetIds"]))
    # CLIや保存処理だけを変えても再推論しない。採取・追跡・推論の実装と重みを版に含める。
    kernel = (sample_frames, frame_timestamps, read_samples, box_iou, Tracker, load_references, Scorer, collect, create_model)
    collector_hash = hashlib.sha256("".join(inspect.getsource(fn) for fn in kernel).encode()).hexdigest()
    weights = {}
    for name in ("det_10g.onnx", "w600k_r50.onnx"):
        file = Path.home() / ".insightface" / "models" / "buffalo_l" / name
        weights[name] = hashlib.sha256(file.read_bytes()).hexdigest()
    metadata = {"referenceVersion": version, "weightsSha256": weights, "kernelSha256": collector_hash,
                "recognitionProvider": args.recognition_provider, "detectionProvider": args.detection_provider,
                "labelsSha256": hashlib.sha256(args.labels.read_bytes()).hexdigest(), "workers": args.workers,
                "packages": {name: importlib.metadata.version(name) for name in ("insightface", "onnxruntime", "numpy")}}
    atomic_json(args.folder / "collection.json", {**metadata, "status": "in-progress"})
    deadline = time.monotonic() + args.timeout_sec
    started = time.monotonic()
    records, pending, errors = {}, [], []
    atomic_json(args.folder / "inference-errors.json", errors)
    output = args.folder / "videos.jsonl"
    output.write_text("")
    output.chmod(0o600)

    def accept(record, label, signature, checkpoint):
        # 正解の修正には特徴量の再計算が要らない。凍結した分割とユーザーの正解だけ差し替える。
        for key in ("videoId", "targetId", "groupId", "split", "label", "labelSource"):
            record[key] = label[key]
        for key in ("selection", "stratum", "samplingProbability"):
            if key in label:
                record[key] = label[key]
        atomic_json(checkpoint, {"signature": signature, "record": record})
        records[label["videoId"]] = record
        with output.open("a") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
        atomic_json(args.folder / "inference-progress.json", {"completed": len(records), "failed": len(errors),
                    "expected": len(labels), "elapsedSec": round(time.monotonic() - started, 1)})
        print(f"[{len(records)}/{len(labels)}] 動画 {label['videoId']} 保存済み", flush=True)

    for label in labels:
        source = sources[label["videoId"]]
        filename = args.folder / source["filename"]
        if hashlib.sha256(filename.read_bytes()).hexdigest() != source["sha256"]:
            raise ValueError("動画ファイルのハッシュが一致しません")
        checkpoint = args.folder / f"{label['videoId']}.scores.json"
        signature = {"collectorSha256": collector_hash, "sourceSha256": source["sha256"],
                     "referenceVersion": version, "temporalStepSec": args.step, "modelWeightsSha256": weights,
                     "recognitionProvider": args.recognition_provider, "detectionProvider": args.detection_provider}
        record = None
        if checkpoint.exists():
            try:
                saved = json.loads(checkpoint.read_text())
            except (ValueError, OSError):
                saved = {}
            if saved.get("signature") == signature and all(saved["record"].get(k) == label[k]
                    for k in ("videoId", "targetId")):
                record = saved["record"]
        if record is None:
            pending.append((filename, label, signature, checkpoint))
        else:
            accept(record, label, signature, checkpoint)
    if pending:
        with ProcessPoolExecutor(max_workers=args.workers, mp_context=multiprocessing.get_context("spawn"),
                initializer=initialize_worker,
                initargs=(args.omokage_root, args.folder, set(manifest["excludedAssetIds"]), version,
                          args.recognition_provider, args.detection_provider)) as pool:
            jobs = {pool.submit(collect_job, filename, label, args.step, deadline): (label, signature, checkpoint)
                    for filename, label, signature, checkpoint in pending}
            for future in as_completed(jobs):
                label, signature, checkpoint = jobs[future]
                try:
                    accept(future.result(), label, signature, checkpoint)
                except Exception as exc:
                    errors.append({"videoId": label["videoId"], "type": type(exc).__name__, "error": str(exc)[:400]})
                    atomic_json(args.folder / "inference-errors.json", errors)
                    print(f"動画 {label['videoId']} 失敗: {type(exc).__name__}", flush=True)
                    if time.monotonic() > deadline:
                        for waiting in jobs:
                            waiting.cancel()
    atomic_json(args.folder / "collection.json", {**metadata, "status": "complete" if not errors else "incomplete",
                "completed": len(records), "expected": len(labels), "errors": errors})
    if errors:
        raise SystemExit(f"{len(errors)}本で採取に失敗。成功した動画は保存済み。inference-errors.json を確認してください")
    # 完了時だけ元の順序で並べ直す。途中停止でも完了済みの動画は上で保存されている。
    output.write_text("".join(json.dumps(records[label["videoId"]], ensure_ascii=False, allow_nan=False) + "\n" for label in labels))
    print(f"{len(records)}本の時系列を保存: {output}", flush=True)


if __name__ == "__main__":
    main()
