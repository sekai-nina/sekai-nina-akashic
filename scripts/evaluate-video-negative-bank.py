"""動画単位の非登場ラベルから負例の手本を作る探索的評価。DBは更新しない。

保存済みの最高点の顔だけを使う。全フレーム版の結果とは別の入力であり、
同じ200本での追加探索なので、新しい独立テストとは呼ばない。
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import runpy
import sys


def fold_of(seed, group):
    return int(hashlib.sha256(f"{seed}:split:{group}".encode()).hexdigest()[:8], 16) % 5


def split_fold(records, fold, seed):
    test = [row for row in records if row["selection"] != "regression" and fold_of(seed, row["groupId"]) == fold]
    training = [row for row in records if row["selection"] == "regression" or fold_of(seed, row["groupId"]) != fold]
    if {row["groupId"] for row in training} & {row["groupId"] for row in test}:
        raise ValueError("同じ動画群が学習と評価に混ざっています")
    return training, test


def decide(predicted_target, positive_similarity, negative_similarity, margin=.05):
    base = predicted_target and positive_similarity is not None and positive_similarity >= .4
    if not base:
        return False
    return negative_similarity is None or negative_similarity <= positive_similarity + margin


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", type=Path, default=Path("reports/video-evidence/large"))
    parser.add_argument("--omokage-root", type=Path, required=True)
    args = parser.parse_args()
    import numpy as np
    folder = args.folder
    report = runpy.run_path(str(Path(__file__).with_name("report-video-benchmark.py")))
    read = report["read_jsonl"]
    candidates = {row["videoId"]: row for row in read(folder / "candidates.jsonl")}
    labels = read(folder / "reviewed-labels.jsonl")
    if len(labels) != 200 or {row["videoId"] for row in labels} != set(candidates):
        raise ValueError("200本の正解が揃っていません")
    rows = []
    for label in labels:
        candidate = candidates[label["videoId"]]
        if type(label["label"]) is not bool or any(label[key] != candidate[key] for key in ("targetId", "groupId", "split")):
            raise ValueError("正解や分割が不正")
        rows.append({**candidate, **label})
    collection = json.loads((folder / "collection.json").read_text())
    spec = importlib.util.spec_from_file_location("collect_negative_bank", Path(__file__).with_name("collect-video-evidence.py"))
    collector = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = collector
    spec.loader.exec_module(collector)
    manifest = json.loads((folder / "manifest.json").read_text())
    scorer, reference_version = collector.load_references(args.omokage_root, folder, set(manifest["excludedAssetIds"]))
    if reference_version != collection["referenceVersion"]:
        raise ValueError("固定した参照と一致しません")
    peaks = {}
    for face in read(folder / "video-peak-embeddings.jsonl"):
        if face["videoId"] not in candidates or face["modelVersion"] not in ("buffalo_l@1", "buffalo_l@2", "buffalo_l@3"):
            raise ValueError("対象外の特徴量")
        vector = np.frombuffer(base64.b64decode(face["embedding"], validate=True), dtype="<f4").copy()
        if vector.shape != (512,) or not np.isfinite(vector).all() or abs(float(np.linalg.norm(vector)) - 1) > .01:
            raise ValueError("特徴量が不正")
        vector /= np.linalg.norm(vector)
        prediction = scorer.predict(vector, candidates[face["videoId"]]["targetId"])
        peaks[face["videoId"]] = {**face, "vector": vector,
                                 "predictedTarget": prediction is not None and prediction["predictedEntityId"] == candidates[face["videoId"]]["targetId"],
                                 "frozenSimilarity": prediction["similarity"] if prediction else None}
    seed = json.loads((folder / "sampling.json").read_text())["seed"]
    all_cases, folds = [], []
    for fold in range(5):
        training, test = split_fold(rows, fold, seed)
        # 非登場なら、映った顔を対象人物の負例とみなせる。登場動画の顔は正例にしない。
        negative_rows = [row for row in training if not row["label"] and row["videoId"] in peaks]
        bank = np.stack([peaks[row["videoId"]]["vector"] for row in negative_rows]) if negative_rows else np.zeros((0, 512), np.float32)
        folds.append({"fold": fold, "training": len(training), "test": len(test),
                      "negativePrototypes": len(bank), "trainingNegativeVideos": [row["videoId"] for row in negative_rows]})
        for row in test:
            face = peaks.get(row["videoId"])
            negative = float(np.max(bank @ face["vector"])) if face is not None and len(bank) else None
            predicted_target = face["predictedTarget"] if face else False
            similarity = face["frozenSimilarity"] if face else None
            all_cases.append({"videoId": row["videoId"], "groupId": row["groupId"], "label": row["label"], "fold": fold,
                              "storedPeakAuto": bool(face and face["similarity"] is not None and face["similarity"] >= .4),
                              "legacyAuto": bool(predicted_target and similarity is not None and similarity >= .4),
                              "temporalAuto": decide(predicted_target, similarity, negative),
                              "frozenPeakSimilarity": similarity, "negativeSimilarity": negative,
                              "peakAvailable": face is not None})
    if len(all_cases) != 197 or len({row["videoId"] for row in all_cases}) != 197:
        raise ValueError("分割評価の件数が不正")
    summary = {"scope": "exploratory second-stage on the same labeled dataset; not a new independent test",
               "input": "one stored CPU peak face per video, reclassified with the frozen reference snapshot",
               "negativeMargin": .05, "positiveExamplesAdded": 0, "videos": len(all_cases),
               "positive": sum(row["label"] for row in all_cases), "negative": sum(not row["label"] for row in all_cases),
               "peakFacesAvailable": len(peaks), "referenceVersion": reference_version,
               "labelsSha256": hashlib.sha256((folder / "reviewed-labels.jsonl").read_bytes()).hexdigest(),
               "storedPeakBaseline": report["metrics_with_intervals"](all_cases, "storedPeakAuto"),
               "frozenPeakBaseline": report["metrics_with_intervals"](all_cases, "legacyAuto"),
               "negativeBank": report["metrics_with_intervals"](all_cases, "temporalAuto"),
               "weightedBaseline": report["weighted_metrics"](all_cases, "legacyAuto", candidates),
               "weightedNegativeBank": report["weighted_metrics"](all_cases, "temporalAuto", candidates),
               "folds": folds, "cases": all_cases}
    output = folder / "negative-bank-experiment.json"
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    output.chmod(0o600)
    print(json.dumps({key: value for key, value in summary.items() if key not in ("folds", "cases")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
