"""#394: 保存済みの顔判定から、手元で評価するスクショ・切り抜きを生成する。

ネットワーク・DB は使用しない。元動画と前回の判定は読み取りだけ。
実行: omokage/.venv/bin/python scripts/face-clip-trial.py --source <clip-trial> --out <出力先>
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from pathlib import Path

import cv2
import numpy as np

NINA = "cmmtp8vrg0004mo381neyztvn"
TITLES = {"A": "トーク 10/30（2 人）", "B": "他のメンバーのトーク", "C": "2 人の TikTok", "D": "番組のリアクション", "E": "画伯 No.1 決定戦"}
SHORT_SECONDS = 180


def command(*args):
    return subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", *map(str, args)], capture_output=True, check=True)


def stamp(t):
    return f"{int(t // 60)}:{int(t % 60):02d}"


def face_at(frame):
    faces = [f for f in frame["faces"] if f["who"] == NINA and f["sim"] >= .4]
    return max(faces, key=lambda f: f["sim"], default=None)


def silence_points(src, duration):
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(src)], capture_output=True, check=True)
    if not probe.stdout.strip():
        return []
    result = command("-i", src, "-vn", "-af", "silencedetect=noise=-32dB:d=0.25", "-f", "null", "-")
    pauses, start = [], None
    for kind, value in re.findall(r"silence_(start|end): ([\d.]+)", result.stderr.decode()):
        if kind == "start":
            start = float(value)
        elif start is not None:
            pauses.append((start + float(value)) / 2)
            start = None
    if start is not None:
        pauses.append((start + duration) / 2)
    return pauses


class CompactDescriptors:
    """全コマの構図をuint8で保持。比較時だけ必要な2コマを浮動小数にする。"""
    def __init__(self, count):
        self.scene = np.zeros((count, 18, 32), dtype=np.uint8)
        self.face = np.zeros((count, 24, 24), dtype=np.uint8)
        self.valid = np.zeros(count, dtype=np.bool_)

    @classmethod
    def from_arrays(cls, scene, face, valid, count):
        if scene.shape != (count, 18, 32) or face.shape != (count, 24, 24) or valid.shape != (count,) or scene.dtype != np.uint8 or face.dtype != np.uint8 or valid.dtype != np.bool_:
            raise ValueError("保存した構図情報の形式が違います")
        result = cls.__new__(cls)
        result.scene, result.face, result.valid = scene, face, valid
        return result

    def __len__(self):
        return len(self.valid)

    def __getitem__(self, index):
        return {"scene": self.scene[index], "face": self.face[index]} if self.valid[index] else None

    def set(self, index, scene, face):
        self.scene[index] = np.rint(scene * 255).astype(np.uint8)
        self.face[index] = np.rint(face * 255).astype(np.uint8)
        self.valid[index] = True


def descriptors(src, meta, compact=False):
    """動画を順に縮小デコードし、構図・顔の見た目の違いとカット候補を得る。"""
    width = 320
    height = int(meta["height"] * width / meta["width"]) // 2 * 2
    step = meta["step"]
    proc = subprocess.Popen([
        "ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-ss", str(step / 2), "-i", str(src), "-vf",
        f"tpad=stop_mode=clone:stop_duration=1,fps=fps={1 / step},scale={width}:{height}",
        "-frames:v", str(len(meta["frames"])),
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-threads", "1", "pipe:1",
    ], stdout=subprocess.PIPE)
    result, cuts, last, last_gray = CompactDescriptors(len(meta["frames"])) if compact else [], [], None, None
    motion = np.zeros(height, dtype=float)
    try:
        for index, frame in enumerate(meta["frames"]):
            size = width * height * 3
            data = bytearray()
            while len(data) < size:
                chunk = proc.stdout.read(size - len(data))
                if not chunk:
                    break
                data.extend(chunk)
            if len(data) != size:
                raise RuntimeError("保存した顔判定とデコードしたコマの数が一致しません")
            img = np.frombuffer(data, np.uint8).reshape(height, width, 3)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            whole = cv2.resize(gray, (32, 18)).astype(float) / 255
            if last is not None and np.mean(np.abs(whole - last)) > .18:
                cuts.append(frame["t"])
            if last_gray is not None:
                motion += np.mean(np.abs(gray.astype(float) - last_gray), axis=1)
            last_gray = gray.astype(float)
            last = whole
            f = face_at(frame)
            if not f:
                if not compact:
                    result.append(None)
                continue
            x1, y1, x2, y2 = f["box"]
            crop = gray[max(0, int(y1 * height)):min(height, int(y2 * height)), max(0, int(x1 * width)):min(width, int(x2 * width))]
            if not crop.size:
                if not compact:
                    result.append(None)
                continue
            face_img = cv2.resize(crop, (24, 24)).astype(float) / 255
            if compact:
                result.set(index, whole, face_img)
            else:
                result.append({"scene": whole, "face": face_img})
        # 端数の余分なコマを読み切り、デコーダを正常終了させる。
        while proc.stdout.read(65536):
            pass
        if proc.wait(timeout=10) != 0:
            raise RuntimeError("動画のデコードに失敗しました")
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=10)
    content = None
    if meta["height"] > meta["width"] * 1.4 and motion.max() > 0:
        # 縦動画の静止した上下帯を避ける別案。映像本体が横長のときだけ採用。
        active = np.flatnonzero(motion > motion.max() * .25)
        if len(active):
            top = max(0, int(active[0] / height * meta["height"]) - 4)
            bottom = min(meta["height"], int((active[-1] + 1) / height * meta["height"]) + 4)
            if 1.35 < meta["width"] / (bottom - top) < 2.1:
                content = [0, top, meta["width"], bottom - top]
    return result, cuts, content


def quality(f):
    # 類似度は本人確認のための門。笑顔・正面だけを優遇しない。
    size = max(0, f["box"][3] - f["box"][1])
    sharp = min(1, math.log1p(f["sharp"]) / math.log(501))
    return .55 * min(size / .32, 1) + .35 * sharp + .10 * f["det"]


def different(a, b):
    def values(desc, key):
        value = desc[key]
        return value.astype(np.float32) / 255 if value.dtype == np.uint8 else value
    scene = float(np.mean(np.abs(values(a["desc"], "scene") - values(b["desc"], "scene"))))
    face = float(np.mean(np.abs(values(a["desc"], "face") - values(b["desc"], "face"))))
    pose = abs(a["face"]["yaw"] - b["face"]["yaw"])
    size = abs((a["face"]["box"][3] - a["face"]["box"][1]) - (b["face"]["box"][3] - b["face"]["box"][1]))
    return scene > .12 or face > .13 or pose > .12 or size > .08


def make_plan(meta, desc, cuts, pauses):
    frames = meta["frames"]
    duration = meta["duration"]
    hits, uncertain = [], 0
    for i, fr in enumerate(frames):
        f = face_at(fr)
        if not f or desc[i] is None:
            continue
        neighbors = [face_at(other) for other in frames[max(0, i - 2):i + 3]]
        # 0.40 の単発誤検出は要確認として数え、強い根拠か近傍の支持を求める。
        supported = f["det"] >= .65 and (f["sim"] >= .5 or sum(n is not None and n["sim"] >= .45 for n in neighbors) >= 2)
        if not supported:
            uncertain += 1
            continue
        hits.append({"t": fr["t"], "face": f, "score": quality(f), "others": len(fr["faces"]) - 1, "desc": desc[i]})

    raw = []
    for hit in hits:
        if raw and hit["t"] - raw[-1][-1]["t"] <= 2:
            raw[-1].append(hit)
        else:
            raw.append([hit])
    windows = []
    if duration > SHORT_SECONDS:
        for group in raw:
            first, last = group[0]["t"], group[-1]["t"]
            # 発言のきっかけを含めるため、前は 5 秒、後ろは 3 秒を目安にする。
            before = [p for p in pauses if first - 10 <= p <= first - 3]
            after = [p for p in pauses if last + 2 <= p <= last + 8]
            start = min(before, key=lambda p: abs(p - (first - 5))) if before else max(0, first - 5)
            end = min(after, key=lambda p: abs(p - (last + 3))) if after else min(duration, last + 3)
            if windows and start <= windows[-1][1]:
                windows[-1][1] = max(end, windows[-1][1])
            else:
                windows.append([start, end])
        split = []
        for start, end in windows:
            while end - start > 60:
                targets = [p for p in pauses if start + 25 <= p <= min(start + 55, end - 8)]
                if not targets:
                    targets = [p for p in cuts if start + 25 <= p <= min(start + 55, end - 8)]
                boundary = min(targets, key=lambda p: abs(p - start - 40)) if targets else start + 45
                split.append([start, boundary + 1])
                start = boundary - 1  # 分割点の前後を両方に残す。
            split.append([start, end])
        windows = split

    # 時間帯ごとに選んだ後、全体でも画像の重複を除く。
    chosen = []
    slot = 8 if duration <= SHORT_SECONDS else 15
    pools = {}
    for hit in hits:
        pools.setdefault(int(hit["t"] // slot), []).append(hit)
    for pool in pools.values():
        for hit in sorted(pool, key=lambda h: -h["score"]):
            if hit["face"]["sharp"] < 15 or hit["face"]["det"] < .75:
                continue
            if all(abs(hit["t"] - s["t"]) >= 2 and different(hit, s) for s in chosen):
                chosen.append(hit)
                break
    # 短尺は画質だけで全候補を落とさない。本人判定の支持がある最良のコマを残す。
    if duration <= SHORT_SECONDS and not chosen and hits:
        chosen.append(max(hits, key=lambda h: h["score"]))
    # 目立つアップを先に置き、構図・表情の変化の候補も残す。
    chosen.sort(key=lambda h: -h["score"])
    for i, shot in enumerate(chosen, 1):
        shot["number"] = i
        shot["kind"] = "アップ" if shot["face"]["box"][3] - shot["face"]["box"][1] >= .2 else "場面・リアクション"
    clips = []
    for i, (start, end) in enumerate(windows, 1):
        contents = [h for h in hits if start <= h["t"] <= end]
        related = [s for s in chosen if start <= s["t"] <= end]
        if contents:
            poster = max(related or contents, key=lambda h: h["score"])
            clips.append({"number": i, "start": round(start, 2), "end": round(end, 2), "posterTime": poster["t"], "score": max(h["score"] for h in contents), "shots": [s["number"] for s in related]})
    for s in chosen:
        del s["desc"]
    return {"duration": duration, "short": duration <= SHORT_SECONDS, "shots": chosen, "clips": clips, "uncertainFrames": uncertain, "rawSegments": len(raw), "pauses": pauses, "cuts": cuts}


def extract(src, target, t, crop=None):
    args = ["-v", "error", "-y", "-ss", str(t), "-i", src, "-frames:v", "1"]
    if crop:
        args += ["-vf", crop]
    command(*args, "-q:v", "2", target)


def render(src, meta, plan, target):
    target.mkdir(parents=True, exist_ok=True)
    for sh in plan["shots"]:
        extract(src, target / f"S{sh['number']}.jpg", sh["t"])
        # 顔が元から十分な画素を持つ単独場面に限り、頭・肩を含めた別案を作る。
        x1, y1, x2, y2 = sh["face"]["box"]
        w, h = meta["width"], meta["height"]
        fh = (y2 - y1) * h
        if plan.get("contentCrop"):
            left, top, cw, ch = plan["contentCrop"]
            extract(src, target / f"S{sh['number']}-crop.jpg", sh["t"], f"crop={cw}:{ch}:{left}:{top}")
            sh["crop"] = True
            sh["cropLabel"] = "映像部分の切り取り版"
        elif sh["others"] == 0 and fh >= 100:
            ch = int(min(h, fh * 4)) // 2 * 2
            cw = int(min(w, ch * .8)) // 2 * 2
            left = int(max(0, min(w - cw, (x1 + x2) * w / 2 - cw / 2)))
            top = int(max(0, min(h - ch, y1 * h - fh * .6)))
            extract(src, target / f"S{sh['number']}-crop.jpg", sh["t"], f"crop={cw}:{ch}:{left}:{top}")
            sh["crop"] = True
            sh["cropLabel"] = "頭・肩を含む切り取り版"
    for clip in plan["clips"]:
        number = clip["number"]
        extract(src, target / f"C{number}.jpg", clip["posterTime"])
        command("-v", "error", "-y", "-ss", clip["start"], "-i", src,
                "-t", round(clip["end"] - clip["start"], 2),
                "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "veryfast",
                "-crf", "20", "-threads", "2", "-c:a", "aac", "-b:a", "160k",
                "-movflags", "+faststart", target / f"C{number}.mp4")


def page(plans, out):
    cards = []
    for vid, plan in plans.items():
        for s in plan["shots"]:
            cards.append({"id": f"{vid}-S{s['number']}", "video": vid, "type": "shot", "title": s["kind"], "time": s["t"], "label": stamp(s["t"]), "image": f"{vid}/S{s['number']}.jpg", "crop": f"{vid}/S{s['number']}-crop.jpg" if s.get("crop") else None, "cropLabel": s.get("cropLabel"), "score": s["score"]})
        for c in plan["clips"]:
            cards.append({"id": f"{vid}-C{c['number']}", "video": vid, "type": "clip", "title": "場面の切り抜き", "time": c["start"], "label": f"{stamp(c['start'])}–{stamp(c['end'])} · {c['end'] - c['start']:.0f}秒", "image": f"{vid}/C{c['number']}.jpg", "file": f"{vid}/C{c['number']}.mp4", "score": c["score"], "related": [f"{vid}-S{n}" for n in c["shots"]]})
    template = Path(__file__).with_name("face-clip-trial.html").read_text()
    payload = json.dumps({"cards": cards, "titles": TITLES, "summary": {k: {"duration": v["duration"], "short": v["short"], "shots": len(v["shots"]), "clips": len(v["clips"]), "uncertain": v["uncertainFrames"]} for k, v in plans.items()}}, ensure_ascii=False).replace("<", "\\u003c")
    (out / "index.html").write_text(template.replace("/*TRIAL_DATA*/", payload))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--only", choices=list(TITLES))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    plans = {}
    for vid in TITLES:
        pp = args.out / f"{vid}.plan.json"
        if args.only and vid != args.only:
            if pp.exists():
                plans[vid] = json.loads(pp.read_text())
            continue
        meta = json.loads((args.source / "out" / f"{vid}.frames.json").read_text())
        src = args.source / "src" / f"{vid}.mp4"
        print(f"{vid}: 構図の比較と音の切れ目を調べています", flush=True)
        desc, cuts, content = descriptors(src, meta)
        pauses = silence_points(src, meta["duration"])
        plan = make_plan(meta, desc, cuts, pauses)
        plan["contentCrop"] = content
        print(f"{vid}: スクショ {len(plan['shots'])} 枚・切り抜き {len(plan['clips'])} 本を生成", flush=True)
        render(src, meta, plan, args.out / vid)
        pp.write_text(json.dumps(plan, ensure_ascii=False, indent=2))
        plans[vid] = plan
    page(plans, args.out)
    print(args.out / "index.html", flush=True)


if __name__ == "__main__":
    main()
