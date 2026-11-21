"""評価前に固定した条件で、正解付き動画の比較を集計する。テスト結果で条件を選ばない。"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
from dataclasses import asdict
import itertools

spec = importlib.util.spec_from_file_location("video_evidence_policy", Path(__file__).with_name("evaluate-video-evidence.py"))
evidence = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = evidence
spec.loader.exec_module(evidence)


def wilson(successes, total):
    """二項比率の95% Wilson区間。層別抽出した母集団全体の区間とは扱わない。"""
    if total == 0:
        return None
    z = 1.959963984540054
    proportion = successes / total
    divisor = 1 + z * z / total
    center = (proportion + z * z / (2 * total)) / divisor
    half = z / divisor * math.sqrt(proportion * (1 - proportion) / total + z * z / (4 * total * total))
    return [max(0, center - half), min(1, center + half)]


def metrics_with_intervals(cases, field):
    result = evidence.metrics(cases, field)
    result["precision95Interval"] = wilson(result["tp"], result["tp"] + result["fp"])
    result["recall95Interval"] = wilson(result["tp"], result["tp"] + result["fn"])
    result["falsePositiveRate95Interval"] = wilson(result["fp"], result["fp"] + result["tn"])
    return result


def weighted_metrics(cases, field, candidates):
    counts = {key: 0.0 for key in ("tp", "fp", "fn", "tn")}
    included = 0
    for case in cases:
        if case["label"] is None:
            continue
        candidate = candidates[case["videoId"]]
        if candidate["selection"] == "regression":
            continue
        probability = candidate["samplingProbability"]
        if probability is None or not 0 < probability <= 1:
            raise ValueError("抽出確率が不正")
        # validation/testへの分割確率は層に共通なので、比率では相殺される。
        weight = 1 / probability
        key = "tp" if case[field] and case["label"] else "fp" if case[field] else "fn" if case["label"] else "tn"
        counts[key] += weight
        included += 1
    tp, fp, fn, tn = (counts[key] for key in ("tp", "fp", "fn", "tn"))
    return {"included": included, "regressionsExcluded": True,
            "precision": tp / (tp + fp) if tp + fp else None,
            "recall": tp / (tp + fn) if tp + fn else None,
            "falsePositiveRate": fp / (fp + tn) if fp + tn else None,
            "note": "抽出確率による探索的な比率。近似重複の未検証と少数サンプルの制約がある。"}


def paired_changes(cases):
    result = {name: {"fixed": 0, "newErrors": 0, "unchangedErrors": 0, "unchangedCorrect": 0}
              for name in ("positive", "negative")}
    for case in cases:
        if case["label"] is None:
            continue
        old_correct = case["legacyAuto"] == case["label"]
        new_correct = case["temporalAuto"] == case["label"]
        key = "fixed" if new_correct and not old_correct else "newErrors" if old_correct and not new_correct else \
              "unchangedCorrect" if new_correct else "unchangedErrors"
        result["positive" if case["label"] else "negative"][key] += 1
    return result


def read_jsonl(filename):
    return [json.loads(line) for line in filename.read_text().splitlines() if line.strip()]


def select_policy(records, candidates, search):
    """最終評価用のレコードを走査せず、調整用だけで1条件を選ぶ。"""
    validation = [record for record in records if record["split"] == "validation"]
    trials, feasible = [], []
    for threshold, hits, span, margin in itertools.product(search["thresholds"], search["minHits"],
                                                         search["minSpanSec"], search["minMargin"]):
        policy = evidence.Policy(threshold=threshold, min_hits=hits, min_span_sec=span, min_margin=margin,
                                 max_gap_sec=search["maxGapSec"], evidence_bin_sec=search["evidenceBinSec"])
        cases = [evidence.evaluate_video(record, policy) for record in validation]
        weighted = weighted_metrics(cases, "temporalAuto", candidates)
        regressions_ok = all(case["temporalAuto"] == case["label"] for case in cases
                             if candidates[case["videoId"]]["selection"] == "regression")
        qualifies = weighted["recall"] is not None and weighted["recall"] >= search["minimumWeightedRecall"]
        if search["regressionsMustMatch"]:
            qualifies = qualifies and regressions_ok
        trial = {"policy": asdict(policy), "validation": metrics_with_intervals(cases, "temporalAuto"),
                 "weightedValidation": weighted, "regressionsMatch": regressions_ok, "feasible": qualifies}
        trials.append(trial)
        if qualifies:
            feasible.append(trial)
    if not feasible:
        return None, {"selectedPolicy": None, "feasibleTrials": 0, "testUsedForSelection": False, "trials": trials}
    best = min(feasible, key=lambda trial: (trial["weightedValidation"]["falsePositiveRate"],
               -trial["weightedValidation"]["recall"], trial["policy"]["threshold"], trial["policy"]["min_margin"],
               trial["policy"]["min_span_sec"], trial["policy"]["min_hits"]))
    return evidence.Policy(**best["policy"]), {"selectedPolicy": best["policy"], "feasibleTrials": len(feasible),
                                              "testUsedForSelection": False, "trials": trials}


def select_max_threshold(records, candidates, thresholds, minimum_recall, fixed_policy):
    validation = [evidence.evaluate_video(record, fixed_policy) for record in records if record["split"] == "validation"]
    trials = []
    for threshold in thresholds:
        cases = [{**case, "temporalAuto": case["legacyMaxSimilarity"] is not None and case["legacyMaxSimilarity"] >= threshold}
                 for case in validation]
        weighted = weighted_metrics(cases, "temporalAuto", candidates)
        regressions_ok = all(case["temporalAuto"] == case["label"] for case in cases
                             if candidates[case["videoId"]]["selection"] == "regression")
        feasible = regressions_ok and weighted["recall"] is not None and weighted["recall"] >= minimum_recall
        trials.append({"threshold": threshold, "weightedValidation": weighted, "feasible": feasible,
                       "validation": metrics_with_intervals(cases, "temporalAuto")})
    feasible = [trial for trial in trials if trial["feasible"]]
    best = min(feasible, key=lambda trial: (trial["weightedValidation"]["falsePositiveRate"],
               -trial["weightedValidation"]["recall"], trial["threshold"])) if feasible else None
    return best["threshold"] if best else None, {"selectedThreshold": best["threshold"] if best else None,
                                                "testUsedForSelection": False, "trials": trials}


def out_of_fold(records, candidates, search, seed, fixed_policy, max_thresholds=None):
    """各動画の正解を条件選択に使わない5分割評価。既知の回帰用3本は採点しない。"""
    def fold_of(record):
        key = f"{seed}:split:{record['groupId']}"
        return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % 5
    rows, folds = [], []
    for fold in range(5):
        train = [{**record, "split": "validation"} for record in records
                 if candidates[record["videoId"]]["selection"] == "regression" or fold_of(record) != fold]
        test = [record for record in records if candidates[record["videoId"]]["selection"] != "regression"
                and fold_of(record) == fold]
        policy, selection = select_policy(train, candidates, search)
        max_threshold, _ = select_max_threshold(train, candidates, max_thresholds, search["minimumWeightedRecall"], fixed_policy) if max_thresholds else (None, None)
        folds.append({"fold": fold, "training": len(train), "test": len(test), "selectedPolicy": selection["selectedPolicy"],
                      "feasibleTrials": selection["feasibleTrials"], "fallbackToLegacy": policy is None,
                      "videoMaxThreshold": max_threshold})
        for record in test:
            fixed = evidence.evaluate_video(record, fixed_policy)
            selected = evidence.evaluate_video(record, policy) if policy else fixed
            rows.append({**selected, "fold": fold, "fixedAuto": fixed["temporalAuto"],
                         "temporalAuto": selected["temporalAuto"] if policy else fixed["legacyAuto"],
                         "videoMaxAuto": fixed["legacyMaxSimilarity"] is not None and fixed["legacyMaxSimilarity"] >= max_threshold
                                          if max_threshold is not None else fixed["legacyAuto"]})
    if len(rows) != len({row["videoId"] for row in rows}):
        raise ValueError("分割評価の採点対象が重複")
    return {"videos": len(rows), "positive": sum(row["label"] for row in rows),
            "negative": sum(not row["label"] for row in rows), "folds": folds,
            "legacy": metrics_with_intervals(rows, "legacyAuto"), "fixed": metrics_with_intervals(rows, "fixedAuto"),
            "selectionProcedure": metrics_with_intervals(rows, "temporalAuto"),
            "videoMaxSelectionProcedure": metrics_with_intervals(rows, "videoMaxAuto"),
            "weightedLegacy": weighted_metrics(rows, "legacyAuto", candidates),
            "weightedSelectionProcedure": weighted_metrics(rows, "temporalAuto", candidates),
            "note": "各動画を条件選択から外した評価。採用候補1個の成績ではなく、条件選択手順の成績。条件が選べないfoldでは従来方式を維持。",
            "cases": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", type=Path, default=Path("reports/video-evidence/large"))
    args = parser.parse_args()
    folder = args.folder
    plan = json.loads((folder / "evaluation-plan.json").read_text())
    collection = json.loads((folder / "collection.json").read_text())
    if collection["status"] != "complete" or collection["completed"] != plan["expectedCases"]:
        raise ValueError("全動画の推論が完了していません")
    labels_file = folder / "reviewed-labels.jsonl"
    if hashlib.sha256(labels_file.read_bytes()).hexdigest() != plan["labelsSha256"]:
        raise ValueError("評価前に固定した正解ファイルが変わっています")
    if collection["labelsSha256"] != plan["labelsSha256"]:
        raise ValueError("走査時の正解の版が違います")
    candidates = {row["videoId"]: row for row in read_jsonl(folder / "candidates.jsonl")}
    if plan.get("candidatesSha256") and hashlib.sha256((folder / "candidates.jsonl").read_bytes()).hexdigest() != plan["candidatesSha256"]:
        raise ValueError("固定した評価対象が変わっています")
    if plan.get("weightsSha256") and collection["weightsSha256"] != plan["weightsSha256"]:
        raise ValueError("固定したモデルの重みが変わっています")
    labels = read_jsonl(labels_file)
    raw = read_jsonl(folder / "videos.jsonl")
    expected_ids = set(candidates)
    if len(raw) != plan["expectedCases"] or len(raw) != len({row["videoId"] for row in raw}):
        raise ValueError("推論結果の不足か重複")
    if {row["videoId"] for row in raw} != expected_ids or {row["videoId"] for row in labels} != expected_ids:
        raise ValueError("選定した動画と推論・正解の動画が一致しません")
    records = evidence.merge_labels(raw, labels)
    for record in records:
        if any(record[key] != candidates[record["videoId"]][key] for key in ("targetId", "groupId", "split")):
            raise ValueError("評価対象の分割が変わっています")
        if record["label"] is None:
            raise ValueError("正解未確認の動画があります")
    selected_policy, selection = select_policy(records, candidates, plan["validationSearch"])
    (folder / "policy-selection.json").write_text(json.dumps(selection, ensure_ascii=False, indent=2) + "\n")
    primary = evidence.compare(records, evidence.Policy(**plan["primaryPolicy"]))
    conservative = evidence.compare(records, evidence.Policy())
    selected = evidence.compare(records, selected_policy) if selected_policy else None
    sampling = json.loads((folder / "sampling.json").read_text())
    max_threshold, max_selection = select_max_threshold(records, candidates, plan["maxOnlyComparison"]["thresholds"],
                                plan["validationSearch"]["minimumWeightedRecall"], evidence.Policy(**plan["primaryPolicy"]))
    (folder / "max-only-selection.json").write_text(json.dumps(max_selection, ensure_ascii=False, indent=2) + "\n")
    cv = out_of_fold(records, candidates, plan["validationSearch"], sampling["seed"], evidence.Policy(**plan["primaryPolicy"]),
                     plan["maxOnlyComparison"]["thresholds"])
    if {case["videoId"] for case in cv["cases"] if case["fold"] == 0} != {record["videoId"] for record in records if record["split"] == "test"}:
        raise ValueError("5分割のfold 0と、固定した最終評価対象が一致しません")
    if primary["referenceVersion"] != collection["referenceVersion"]:
        raise ValueError("推論結果と採取記録の参照が一致しません")
    summary = {"expectedCases": plan["expectedCases"], "labelsSha256": plan["labelsSha256"],
               "referenceVersion": collection["referenceVersion"], "primaryPolicy": plan["primaryPolicy"],
               "runtime": {"detection": collection.get("detectionProvider", "cpu"),
                           "recognition": collection.get("recognitionProvider", "cpu"),
                           "weightsSha256": collection["weightsSha256"]},
               "baselineNote": "同じ固定した参照・重み・実行環境で旧方式を再計算。本番の過去タグそのものではない。",
               "probabilityCalibrated": False, "splits": {}}
    summary["validationSelectedPolicy"] = selection["selectedPolicy"]
    summary["feasibleValidationTrials"] = selection["feasibleTrials"]
    summary["validationSelectedMaxThreshold"] = max_threshold
    summary["outOfFold"] = {key: value for key, value in cv.items() if key != "cases"}
    families = []
    if selected:
        selected_validation = [case for case in selected["cases"] if case["split"] == "validation"]
        families.append({"method": "temporal", "policy": selection["selectedPolicy"], "parameterCount": 4,
                         "weightedValidation": weighted_metrics(selected_validation, "temporalAuto", candidates)})
    if max_threshold is not None:
        max_validation = [{**case, "temporalAuto": case["legacyMaxSimilarity"] is not None and case["legacyMaxSimilarity"] >= max_threshold}
                          for case in primary["cases"] if case["split"] == "validation"]
        families.append({"method": "max-only", "threshold": max_threshold, "parameterCount": 1,
                         "weightedValidation": weighted_metrics(max_validation, "temporalAuto", candidates)})
    summary["recommendedByValidation"] = min(families, key=lambda family:
        (family["weightedValidation"]["falsePositiveRate"], -family["weightedValidation"]["recall"], family["parameterCount"])) if families else None
    for split in ("validation", "test"):
        cases = [case for case in primary["cases"] if case["split"] == split]
        conservative_cases = [case for case in conservative["cases"] if case["split"] == split]
        summary["splits"][split] = {
            "videos": len(cases), "positive": sum(case["label"] for case in cases),
            "negative": sum(not case["label"] for case in cases),
            "legacy": metrics_with_intervals(cases, "legacyAuto"),
            "primary": metrics_with_intervals(cases, "temporalAuto"),
            "conservative": metrics_with_intervals(conservative_cases, "temporalAuto"),
            "pairedChanges": paired_changes(cases),
            "weightedLegacy": weighted_metrics(cases, "legacyAuto", candidates),
            "weightedPrimary": weighted_metrics(cases, "temporalAuto", candidates),
        }
        dense_cases = [{**case, "denseMaxAuto": case["maxSimilarity"] is not None and case["maxSimilarity"] >= .4}
                       for case in cases]
        summary["splits"][split]["denseMaxControl"] = metrics_with_intervals(dense_cases, "denseMaxAuto")
        if selected:
            selected_cases = [case for case in selected["cases"] if case["split"] == split]
            summary["splits"][split]["validationSelected"] = metrics_with_intervals(selected_cases, "temporalAuto")
            summary["splits"][split]["weightedValidationSelected"] = weighted_metrics(selected_cases, "temporalAuto", candidates)
            summary["splits"][split]["selectedPairedChanges"] = paired_changes(selected_cases)
        if max_threshold is not None:
            max_cases = [{**case, "temporalAuto": case["legacyMaxSimilarity"] is not None and case["legacyMaxSimilarity"] >= max_threshold}
                         for case in cases]
            summary["splits"][split]["videoMaxSelected"] = metrics_with_intervals(max_cases, "temporalAuto")
            summary["splits"][split]["weightedVideoMaxSelected"] = weighted_metrics(max_cases, "temporalAuto", candidates)
    test = [case for case in primary["cases"] if case["split"] == "test"]
    selected_by_id = {case["videoId"]: case for case in selected["cases"]} if selected else {}
    errors = []
    for case in test:
        alternatives = {}
        if selected:
            alternatives["validationSelectedAuto"] = selected_by_id[case["videoId"]]["temporalAuto"]
        if max_threshold is not None:
            alternatives["videoMaxSelectedAuto"] = case["legacyMaxSimilarity"] is not None and case["legacyMaxSimilarity"] >= max_threshold
        if any(prediction != case["label"] for prediction in [case["legacyAuto"], case["temporalAuto"], *alternatives.values()]):
            errors.append({**case, **alternatives, "sourceUrl": candidates[case["videoId"]]["sourceUrl"]})
    for name, value in (("comparison.json", primary), ("comparison-conservative.json", conservative),
                        ("comparison-validation-selected.json", selected),
                        ("out-of-fold.json", cv),
                        ("benchmark-summary.json", summary), ("test-error-cases.json", errors)):
        file = folder / name
        file.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        file.chmod(0o600)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
