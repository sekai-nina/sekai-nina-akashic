"""人が動画全体に付けた正解と、保存済み時系列スコアで自動タグの規則を比較する。

標準ライブラリのみ。DB・ネットワーク・顔モデルを使わず、本番のタグを書き換えない。
実行例: python3 scripts/evaluate-video-evidence.py --input /path/to/videos.jsonl
入力の仕様と制約: docs/video-evidence-evaluation.md
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import statistics


@dataclass(frozen=True)
class Policy:
    threshold: float = 0.4
    min_det_score: float = 0.5
    min_hits: int = 3
    min_span_sec: float = 2.0
    max_gap_sec: float = 2.0
    evidence_bin_sec: float = 1.0
    min_margin: float = 0.0

    def __post_init__(self):
        if not -1 <= self.threshold <= 1 or not 0 <= self.min_det_score <= 1:
            raise ValueError("スコアの閾値が範囲外")
        if not 0 <= self.min_margin <= 2:
            raise ValueError("候補間の差は0〜2にする")
        if isinstance(self.min_hits, bool) or not isinstance(self.min_hits, int) or self.min_hits < 2:
            raise ValueError("min_hits は 2 以上の整数にする")
        for value in (self.min_span_sec, self.max_gap_sec, self.evidence_bin_sec):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("時間の設定は有限の正数にする")


def number(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} は数値にする")
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{name} が範囲外")
    return value


def identifier(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} は空でない文字列にする")
    return value


def validate(record):
    for key in ("videoId", "targetId", "groupId", "modelVersion", "referenceVersion"):
        identifier(record.get(key), key)
    if record.get("split") not in ("validation", "test"):
        raise ValueError("split は validation / test にする")
    label = record.get("label")
    if label is not None and type(label) is not bool:
        raise ValueError("label は true / false / null にする")
    if label is not None:
        identifier(record.get("labelSource"), "labelSource")
    duration = number(record.get("durationSec"), "durationSec", 0.001, 86400)
    frames = record.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ValueError("frames は顔のないコマも含む、空でない配列にする")
    previous = -1
    for frame in frames:
        t = number(frame.get("t"), "t", 0, duration)
        if t <= previous:
            raise ValueError("コマの t は重複のない昇順にする")
        previous = t
        if type(frame.get("sceneCut", False)) is not bool:
            raise ValueError("sceneCut は bool にする")
        for name in ("legacySample", "temporalSample"):
            if type(frame.get(name, True)) is not bool:
                raise ValueError(f"{name} は bool にする")
        faces = frame.get("faces")
        if not isinstance(faces, list):
            raise ValueError("faces は配列にする")
        seen = set()
        for face in faces:
            identifier(face.get("predictedEntityId"), "predictedEntityId")
            number(face.get("similarity"), "similarity", -1, 1)
            number(face.get("detScore"), "detScore", 0, 1)
            if face.get("runnerUpSimilarity") is not None:
                number(face["runnerUpSimilarity"], "runnerUpSimilarity", -1, 1)
            track = face.get("trackId")
            if track is not None:
                identifier(track, "trackId")
                if track in seen:
                    raise ValueError("同じコマに同じ trackId が複数ある")
                seen.add(track)


def evaluate_video(record, policy):
    validate(record)
    target = record["targetId"]
    best_similarity = None
    legacy_auto = False
    legacy_max_similarity = None
    temporal_auto = False
    untracked_hits = 0
    tracks = {}
    best_support = {"distinctBins": 0, "spanSec": 0.0, "medianSimilarity": None}
    for frame in record["frames"]:
        t = frame["t"]
        if frame.get("sceneCut"):
            tracks.clear()
        for face in frame["faces"]:
            track = face.get("trackId")
            is_target = face["predictedEntityId"] == target
            eligible = is_target and face["detScore"] >= policy.min_det_score
            if eligible:
                sim = face["similarity"]
                best_similarity = sim if best_similarity is None else max(best_similarity, sim)
                if frame.get("legacySample", True):
                    legacy_max_similarity = sim if legacy_max_similarity is None else max(legacy_max_similarity, sim)
            hit = eligible and face["similarity"] >= policy.threshold
            # 比較対象は旧サーバーの固定閾値0.4。新方式の閾値やmarginで旧方式を変えない。
            legacy_auto |= is_target and face["detScore"] >= .5 and face["similarity"] >= .4 and frame.get("legacySample", True)
            if policy.min_margin > 0:
                runner_up = face.get("runnerUpSimilarity")
                hit = hit and runner_up is not None and face["similarity"] - runner_up >= policy.min_margin
            if not frame.get("temporalSample", True):
                continue
            if track is None:
                untracked_hits += int(hit)
                continue
            if not hit:
                # 別候補や閾値未満を挟んだ同じ顔の検出は、連続する裏付けにしない。
                tracks.pop(track, None)
                continue
            run = tracks.get(track)
            if run is None or t - run["last"] > policy.max_gap_sec:
                run = {"start": t, "last": t, "bins": {}}
                tracks[track] = run
            run["last"] = t
            # 動画の絶対秒の境目で採否が変わらないよう、検出区間の開始を原点にする。
            bucket = math.floor((t - run["start"] + 1e-6) / policy.evidence_bin_sec)
            # 密な近接コマを何十件と足し上げない。時間の1枠につき1件。
            run["bins"][bucket] = max(run["bins"].get(bucket, -1), face["similarity"])
            span = t - run["start"]
            count = len(run["bins"])
            if (span, count) > (best_support["spanSec"], best_support["distinctBins"]):
                best_support = {"distinctBins": count, "spanSec": round(span, 6),
                                "medianSimilarity": statistics.median(run["bins"].values())}
            temporal_auto |= count >= policy.min_hits and span >= policy.min_span_sec
    return {"videoId": record["videoId"], "targetId": target, "split": record["split"],
            "groupId": record["groupId"], "label": record.get("label"),
            "labelSource": record.get("labelSource"), "maxSimilarity": best_similarity,
            "legacyMaxSimilarity": legacy_max_similarity,
            "legacyAuto": legacy_auto, "temporalAuto": temporal_auto,
            "bestSupport": best_support, "untrackedHits": untracked_hits}


def metrics(cases, field):
    labeled = [case for case in cases if case["label"] is not None]
    tp = sum(case[field] and case["label"] for case in labeled)
    fp = sum(case[field] and not case["label"] for case in labeled)
    fn = sum(not case[field] and case["label"] for case in labeled)
    tn = len(labeled) - tp - fp - fn
    return {"labeled": len(labeled), "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": tp / (tp + fp) if tp + fp else None,
            "recall": tp / (tp + fn) if tp + fn else None,
            "falsePositiveRate": fp / (fp + tn) if fp + tn else None}


def compare(records, policy):
    groups, videos, pairs = {}, {}, set()
    cases = []
    versions = set()
    for record in records:
        validate(record)
        versions.add((record["modelVersion"], record["referenceVersion"]))
        if len(versions) > 1:
            raise ValueError("比較するモデル・参照の版を揃える")
        pair = record["videoId"], record["targetId"]
        if pair in pairs:
            raise ValueError("同じ videoId / targetId の重複")
        pairs.add(pair)
        for key, table in ((record["groupId"], groups), (record["videoId"], videos)):
            if key in table and table[key] != record["split"]:
                raise ValueError("同じ動画・関連動画群を validation / test に分けない")
            table[key] = record["split"]
        cases.append(evaluate_video(record, policy))
    if not cases:
        raise ValueError("入力が空")
    model, references = next(iter(versions))
    labeled_count = sum(case["label"] is not None for case in cases)
    return {"policy": asdict(policy), "modelVersion": model, "referenceVersion": references,
            "groundTruthCoverage": {"total": len(cases), "labeled": labeled_count, "unknown": len(cases) - labeled_count},
            "evaluationStatus": "incomplete-ground-truth" if labeled_count < len(cases) else
                                "labeled-test-available" if any(case["split"] == "test" for case in cases) else "validation-only",
            "probabilityCalibrated": False,
            "note": "auto=false は確認待ち。非登場の断定ではない。規則の比較であり確率ではない。",
            "splits": {split: {"cases": sum(c["split"] == split for c in cases),
                               "legacy": metrics([c for c in cases if c["split"] == split], "legacyAuto"),
                               "temporal": metrics([c for c in cases if c["split"] == split], "temporalAuto")}
                       for split in ("validation", "test")},
            "cases": cases}


def merge_labels(records, labels):
    """顔単位の判断ではなく、動画全体の人手ラベルだけを結合する。"""
    by_key = {}
    for label in labels:
        for key in ("videoId", "targetId", "groupId", "labelSource"):
            identifier(label.get(key), key)
        if type(label.get("label")) is not bool or label.get("split") not in ("validation", "test"):
            raise ValueError("ラベルには動画全体の bool の正解と split が必要")
        key = label["videoId"], label["targetId"]
        if key in by_key:
            raise ValueError("正解ラベルの重複")
        by_key[key] = label
    result = []
    for record in records:
        label = by_key.get((record.get("videoId"), record.get("targetId")))
        if label:
            for field in ("groupId", "split", "label"):
                if record.get(field) is not None and record[field] != label[field]:
                    raise ValueError(f"時系列と正解ラベルの {field} が矛盾")
            record = {**record, **{key: label[key] for key in ("groupId", "split", "label", "labelSource")}}
        result.append(record)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--labels", type=Path, help="動画全体の正解ラベル JSONL を結合する")
    parser.add_argument("--threshold", type=float, default=0.4)
    parser.add_argument("--min-hits", type=int, default=3)
    parser.add_argument("--min-span-sec", type=float, default=2.0)
    parser.add_argument("--max-gap-sec", type=float, default=2.0)
    parser.add_argument("--evidence-bin-sec", type=float, default=1.0)
    parser.add_argument("--min-margin", type=float, default=0.0)
    parser.add_argument("--require-complete", action="store_true", help="正解未確認の動画があれば精度レポートを作らない")
    args = parser.parse_args()
    try:
        records = []
        for line_no, line in enumerate(args.input.read_text().splitlines(), 1):
            if line.strip():
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        raise ValueError("1行はJSONオブジェクトにする")
                    records.append(record)
                except (ValueError, TypeError, AttributeError) as exc:
                    raise ValueError(f"{line_no}行目: {exc}") from exc
        if args.labels:
            labels = [json.loads(line) for line in args.labels.read_text().splitlines() if line.strip()]
            records = merge_labels(records, labels)
        for line_no, record in enumerate(records, 1):
            try:
                validate(record)
            except (ValueError, TypeError, AttributeError) as exc:
                raise ValueError(f"レコード{line_no}: {exc}") from exc
        policy = Policy(threshold=args.threshold, min_hits=args.min_hits,
                        min_span_sec=args.min_span_sec, max_gap_sec=args.max_gap_sec,
                        evidence_bin_sec=args.evidence_bin_sec, min_margin=args.min_margin)
        report = compare(records, policy)
        if args.require_complete and report["groundTruthCoverage"]["unknown"]:
            raise ValueError("正解未確認の動画があります。未確認を非登場として精度集計しないでください")
        result = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            if args.output.resolve() == args.input.resolve():
                raise ValueError("出力先で入力を上書きしない")
            if args.labels and args.output.resolve() == args.labels.resolve():
                raise ValueError("出力先で正解ラベルを上書きしない")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(result)
        else:
            print(result, end="")
    except (ValueError, TypeError, AttributeError, OSError) as exc:
        parser.exit(2, f"入力・設定エラー: {exc}\n")


if __name__ == "__main__":
    main()
