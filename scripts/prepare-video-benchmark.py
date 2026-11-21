"""母集団からスコア帯別に動画を抽出し、正解入力をまとめるローカルHTMLを作る。

自動スコアは抽出の層だけに使い、登場の正解には使わない。動画の秒数入力は不要。
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path

STRATA = ("no_candidate", "below_0.4", "0.4_to_0.5", "0.5_to_0.6", "at_least_0.6")


def stratum(score):
    if score is None:
        return STRATA[0]
    if score < .4:
        return STRATA[1]
    if score < .5:
        return STRATA[2]
    if score < .6:
        return STRATA[3]
    return STRATA[4]


def rank(seed, domain, value):
    return hashlib.sha256(f"{seed}:{domain}:{value}".encode()).hexdigest()


def prepare(inventory, labels, size=200, seed="video-evidence-20261121-v1"):
    if not 5 <= size <= 1000:
        raise ValueError("評価対象は5〜1000本にする")
    items = inventory["items"]
    target = inventory["targetId"]
    known = {item["videoId"]: item for item in labels if item["targetId"] == target}
    if len(known) != len(labels) or any(type(item.get("label")) is not bool for item in labels):
        raise ValueError("既知の正解は対象1人・動画IDの重複なし・boolにする")
    # 同じ実体の動画は1件にする。既知の正解がある方を優先する。
    unique = {}
    by_id = {}
    for item in sorted(items, key=lambda value: value["videoId"] not in known):
        key = "sha256:" + item["sha256"] if item.get("sha256") else "asset:" + item["assetId"]
        if key not in unique:
            unique[key] = {**item, "groupId": key}
        by_id[item["videoId"]] = key
    if any(video not in by_id for video in known):
        raise ValueError("回帰確認用の動画が母集団にありません")
    forced = []
    forced_groups = set()
    for video, label in known.items():
        group = by_id[video]
        if group in forced_groups:
            previous = next(row for row in forced if row["groupId"] == group)
            if previous["label"] != label["label"]:
                raise ValueError("同一動画に矛盾する正解があります")
            continue
        forced_groups.add(group)
        forced.append({**unique[group], **label, "groupId": group, "split": "validation", "selection": "regression"})
    pools = defaultdict(list)
    for group, item in unique.items():
        if group not in forced_groups:
            pools[stratum(item["legacyMaxSimilarity"])].append(item)
    for pool in pools.values():
        pool.sort(key=lambda item: rank(seed, "sample", item["groupId"]))
    remaining = min(size, len(unique)) - len(forced)
    if remaining < 0:
        raise ValueError("回帰確認用の本数より大きいsizeが必要")
    chosen = []
    quotas = Counter()
    # 余りや不足する層も含め、5つの層から順番に均等抽出する。
    while len(chosen) < remaining:
        before = len(chosen)
        for name in STRATA:
            if quotas[name] < len(pools[name]) and len(chosen) < remaining:
                chosen.append(pools[name][quotas[name]])
                quotas[name] += 1
        if len(chosen) == before:
            break
    records = []
    for item in forced + chosen:
        name = stratum(item["legacyMaxSimilarity"])
        regression = item.get("selection") == "regression"
        # 抽出とは別のハッシュで分割を固定。既知3本は調整用だけに置く。
        split = "validation" if regression or int(rank(seed, "split", item["groupId"])[:8], 16) % 5 else "test"
        records.append({**item, "targetId": target, "split": split,
                        "label": item["label"] if regression else None,
                        "labelSource": item.get("labelSource") if regression else None,
                        "sourceUrl": f"https://www.tiktok.com/@{item['handle']}/video/{item['videoId']}",
                        "selection": "regression" if regression else "stratified-random",
                        "stratum": name,
                        "samplingProbability": None if regression else quotas[name] / len(pools[name])})
    summary = {"seed": seed, "population": len(items), "uniquePopulation": len(unique), "selected": len(records),
               "populationStrata": dict(Counter(stratum(item["legacyMaxSimilarity"]) for item in unique.values())),
               "selectedStrata": dict(Counter(item["stratum"] for item in records)),
               "splits": dict(Counter(item["split"] for item in records)),
               "labeled": sum(item["label"] is not None for item in records),
               "totalBytes": sum(item["fileSize"] for item in records),
               "totalDurationSec": sum(item.get("durationSec") or 0 for item in records),
               "duplicateGrouping": "exact-sha256-only; near-duplicates-not-verified",
               "note": "スコア帯を均等にした抽出。未確認は精度集計から除外。単純な正解率を母集団全体の精度と解釈しない。"}
    return records, summary


HTML = r'''<!doctype html><html lang="ja"><meta charset="utf-8"><title>動画の正解確認</title>
<style>body{font:17px system-ui;background:#101820;color:#f4f5f6;max-width:1000px;margin:24px auto;padding:0 20px}video{width:100%;height:60vh;background:#000}button,select,a{font:inherit;margin:8px;padding:10px}button{cursor:pointer}a{color:#8bdcff}#status{color:#c4d3df}.controls{display:flex;flex-wrap:wrap}button.active{outline:3px solid #7fd2ff}</style>
<h1>動画全体に映っているかだけを確認</h1><p>秒数の指定は不要です。判断できない動画は「不明」にします。自動予測は表示しません。</p>
<p id="status"></p><video id="video" controls preload="none"></video><p><a id="source" target="_blank" rel="noopener">TikTokで開く</a></p>
<div class="controls"><button id="yes">映っている [Y]</button><button id="no">映っていない [N]</button><button id="unknown">不明 [U]</button></div>
<div class="controls"><button id="prev">前へ</button><button id="next">次へ</button><button id="unreviewed">未確認へ</button><button id="save">正解をJSONL保存</button></div>
<p>保存ファイルはこのページと同じフォルダの <code>reviewed-labels.jsonl</code> として使えます。動画が読めない場合はTikTokのリンクで確認できます。</p>
<script>const records=__RECORDS__;const key=__KEY__;let answers={};try{answers=JSON.parse(localStorage.getItem(key)||'{}')}catch{}let index=0;
const el=id=>document.getElementById(id);const value=r=>Object.hasOwn(answers,r.videoId)?answers[r.videoId].label:r.label;
function show(){const r=records[index];el('video').pause();el('video').src='./'+r.videoId+'.mp4';el('source').href=r.sourceUrl;const reviewed=records.filter(r=>value(r)!==null).length;el('status').textContent=`${index+1} / ${records.length}本　登場／非登場が確認済み ${reviewed}本　現在：${value(r)===true?'登場':value(r)===false?'非登場':'未確認・不明'}`;el('yes').classList.toggle('active',value(r)===true);el('no').classList.toggle('active',value(r)===false)}
function answer(label){const r=records[index];answers[r.videoId]={videoId:r.videoId,targetId:r.targetId,groupId:r.groupId,split:r.split,label,labelSource:label===null?null:'human-full-video-review',reviewedAt:new Date().toISOString()};try{localStorage.setItem(key,JSON.stringify(answers))}catch{}if(index<records.length-1)index++;show()}
el('yes').onclick=()=>answer(true);el('no').onclick=()=>answer(false);el('unknown').onclick=()=>answer(null);el('prev').onclick=()=>{index=Math.max(0,index-1);show()};el('next').onclick=()=>{index=Math.min(records.length-1,index+1);show()};el('unreviewed').onclick=()=>{const at=records.findIndex(r=>value(r)===null&&!Object.hasOwn(answers,r.videoId));if(at>=0)index=at;show()};
el('save').onclick=()=>{const rows=records.map(r=>Object.hasOwn(answers,r.videoId)?answers[r.videoId]:({videoId:r.videoId,targetId:r.targetId,groupId:r.groupId,split:r.split,label:r.label,labelSource:r.labelSource})).filter(r=>r.label!==null);const url=URL.createObjectURL(new Blob([rows.map(r=>JSON.stringify(r)).join('\n')+'\n'],{type:'application/x-ndjson'}));const a=document.createElement('a');a.href=url;a.download='reviewed-labels.jsonl';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select')||e.ctrlKey||e.metaKey||e.altKey)return;const k=e.key.toLowerCase();if(k==='y')answer(true);if(k==='n')answer(false);if(k==='u')answer(null)});show();</script></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", type=Path, default=Path("reports/video-evidence/large"))
    parser.add_argument("--labels", type=Path, default=Path("data/video-evidence-labels.jsonl"))
    parser.add_argument("--size", type=int, default=200)
    args = parser.parse_args()
    inventory = json.loads((args.folder / "inventory.json").read_text())
    labels = [json.loads(line) for line in args.labels.read_text().splitlines() if line.strip()]
    records, summary = prepare(inventory, labels, args.size)
    # 人が追記したラベルは再生成で上書きしない。
    reviewed = args.folder / "reviewed-labels.jsonl"
    if not reviewed.exists():
        reviewed.write_text("".join(json.dumps({key: row[key] for key in
                            ("videoId", "targetId", "groupId", "split", "label", "labelSource")}, ensure_ascii=False) + "\n"
                            for row in records if row["label"] is not None))
        reviewed.chmod(0o600)
    for name, content in (("candidates.jsonl", "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)),
                          ("sampling.json", json.dumps(summary, ensure_ascii=False, indent=2) + "\n")):
        output = args.folder / name
        output.write_text(content)
        output.chmod(0o600)
    # HTMLには予測値・層・分割を表示しない。JS文字列内からHTMLが閉じられないようにする。
    compact = [{k: row[k] for k in ("videoId", "targetId", "groupId", "split", "label", "labelSource", "sourceUrl")} for row in records]
    payload = json.dumps(compact, ensure_ascii=False).replace("<", "\\u003c")
    key = "video-evidence-review-" + hashlib.sha256(payload.encode()).hexdigest()[:16]
    (args.folder / "review.html").write_text(HTML.replace("__RECORDS__", payload).replace("__KEY__", json.dumps(key)))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
