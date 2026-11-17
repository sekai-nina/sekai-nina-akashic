"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Camera, Play, Scissors } from "lucide-react";
import { SCENE_LABELS as L, ExportRange, MAX_EXPORT_SECONDS, mediaSize, sceneTime, sceneProgressKey, type VideoScenesView, type SceneView } from "@/lib/video-scenes/policy";
import { sceneMediaUrl, sceneSourceUrl, saveSceneBlob } from "@/lib/video-scenes/download";
import { generateVideoScenes, exportVideoScene } from "./actions";
import { SceneDownloadButton } from "./download-button";

const buttonClass = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 disabled:opacity-50";

export function VideoSceneBoard({ initial, editable, initialTime = 0 }: { initial: VideoScenesView; editable: boolean; initialTime?: number }) {
  const [data, setData] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState(initialTime > 0 || !initial.scenes.length);
  const [previewRequested, setPreviewRequested] = useState(false);
  const [start, setStart] = useState(Math.max(0, initialTime - 5));
  const [end, setEnd] = useState(Math.min(initial.duration ?? initialTime + 20, initialTime + 15));
  const [duration, setDuration] = useState(initial.duration);
  const [error, setError] = useState<string | null>(null);
  const [busy, transition] = useTransition();
  const video = useRef<HTMLVideoElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const pendingTime = useRef(initialTime);
  const previewEnd = useRef<number | null>(null);
  const playWhenLoaded = useRef(false);
  const progressKey = useRef(sceneProgressKey([...(initial.task ? [initial.task] : []), ...initial.exports]));
  const active = data.scenes.find((s) => s.id === selectedId) ?? null;
  const source = sourceMode || !active?.video;
  const playerUrl = source ? sceneSourceUrl(data.asset.id) : sceneMediaUrl(active!.video!.id);
  const offset = source ? 0 : active?.start ?? 0;
  const working = ["queued", "processing"].includes(data.task?.status ?? "") || data.exports.some((e) => ["queued", "processing"].includes(e.status));

  useEffect(() => {
    progressKey.current = sceneProgressKey([...(data.task ? [data.task] : []), ...data.exports]);
  }, [data]);

  async function refresh(signal?: AbortSignal) {
    const response = await fetch(`/api/video-scenes/assets/${encodeURIComponent(data.asset.id)}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error("場面の情報を取得できませんでした");
    const next: VideoScenesView = await response.json();
    if (!signal?.aborted) { setData(next); if (next.duration != null) setDuration(next.duration); }
  }

  useEffect(() => {
    if (!working) return;
    const abort = new AbortController();
    let inFlight = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > 30 * 60_000) { clearInterval(timer); return; }
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const endpoint = `/api/video-scenes/assets/${encodeURIComponent(initial.asset.id)}`;
        const response = await fetch(`${endpoint}?progress=1`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) { clearInterval(timer); if (!abort.signal.aborted) setError("生成状況を確認できません。更新ボタンで再確認してください"); return; }
        const progress: { tasks: { id: string; status: string }[] } = await response.json();
        if (sceneProgressKey(progress.tasks) === progressKey.current) return;
        const full = await fetch(endpoint, { signal: abort.signal, cache: "no-store" });
        if (!full.ok) { clearInterval(timer); if (!abort.signal.aborted) setError("場面を取得できません。ログイン状態を確認してください"); return; }
        const next: VideoScenesView = await full.json();
        if (!abort.signal.aborted) { setData(next); if (next.duration != null) setDuration(next.duration); }
      } catch { /* 次の回に確認する。画面を閉じたら中止する。 */ }
      finally { inFlight = false; }
    }, 10_000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [working, initial.asset.id]);

  function seek(time: number, useSource: boolean) {
    const targetOffset = useSource ? 0 : active?.start ?? 0;
    pendingTime.current = time;
    setSourceMode(useSource);
    if (useSource === source && video.current?.readyState) {
      video.current.currentTime = Math.max(0, time - targetOffset);
      if (playWhenLoaded.current) { playWhenLoaded.current = false; void video.current.play().catch(() => {}); }
      setPreviewRequested(false);
    } else {
      // 未再生・URL 切替時も、指定コマを読むためのメタデータ取得を開始する。
      setPreviewRequested(true);
    }
  }

  function choose(scene: SceneView) {
    setPreviewRequested(false);
    previewEnd.current = null;
    pendingTime.current = scene.start;
    setSelectedId(scene.id); setSourceMode(!scene.video);
    setStart(scene.start); setEnd(Math.min(scene.end, scene.start + MAX_EXPORT_SECONDS));
    // 短い動画ではプレーヤーの URL が変わらないので明示的に移動する。
    if (!scene.video && source && video.current?.readyState) video.current.currentTime = scene.start;
    player.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function markCurrent() {
    const time = (video.current?.currentTime ?? 0) + offset;
    const nearest = data.scenes.find((s) => s.start <= time && time <= s.end);
    if (nearest && source) setSelectedId(nearest.id);
    setStart(Math.max(0, time - 5)); setEnd(Math.min(duration ?? time + 15, time + 15));
    previewEnd.current = null;
  }

  async function screenshot() {
    const el = video.current;
    if (!el?.videoWidth || el.readyState < 2) { setError("動画のコマを表示してから保存してください"); return; }
    el.pause();
    const canvas = document.createElement("canvas");
    canvas.width = el.videoWidth; canvas.height = el.videoHeight;
    canvas.getContext("2d")?.drawImage(el, 0, 0);
    const time = el.currentTime + offset;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", .95));
    if (blob) saveSceneBlob(blob, `${data.asset.id}-${time.toFixed(1)}s.jpg`);
  }

  const range = ExportRange.safeParse({ start, end });
  const rangeValid = range.success && duration != null && end <= duration;
  const estimated = rangeValid && data.asset.fileSize != null && duration
    ? Math.round(data.asset.fileSize / duration * (end - start)) : null;

  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-xs font-medium text-sky-700">{L.title}</p><h1 className="mt-1 text-xl font-bold text-slate-900">{data.asset.title || "動画"}</h1>
        <Link href={`/assets/${data.asset.id}`} className="text-xs text-slate-500 underline">元アセットの詳細</Link></div>
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} onClick={() => { previewEnd.current = null; seek(0, true); }}>{L.source}</button>
        <button className={buttonClass} disabled={busy} onClick={() => { setError(null); transition(async () => { try { await refresh(); } catch (e) { setError((e as Error).message); } }); }}>生成状況を更新</button>
        {editable && (!data.task || data.task.status === "failed") && <button className={buttonClass} disabled={busy} onClick={() => transition(async () => {
          setError(null); const result = await generateVideoScenes(data.asset.id);
          if (!result.ok) setError(result.error); else { setData((d) => ({ ...d, task: result.task })); }
        })}>{data.task ? L.retry : L.create}</button>}
      </div>
    </div>
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {data.task && data.task.status !== "ready" && <p role="status" className="rounded-lg bg-sky-50 p-3 text-sm text-sky-900">{L[data.task.status as keyof typeof L] ?? data.task.status}{data.task.error ? ` · ${data.task.error}` : " · 完了した場面はここに表示されます。画面を閉じても処理は続きます。"}</p>}

    <div ref={player} className="scroll-mt-20 rounded-xl border border-slate-200 bg-white p-3 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm"><strong>{source ? "元動画" : `${sceneTime(active?.start ?? 0)}–${sceneTime(active?.end ?? 0)} の場面`}</strong>
        {active && <button className="min-h-10 text-sky-700" onClick={() => { previewEnd.current = null; seek(Math.max(0, active.start - 10), true); }}>元動画の前後を見る →</button>}</div>
      <video key={playerUrl} ref={video} controls playsInline preload={previewRequested ? "metadata" : "none"} src={playerUrl}
        poster={active ? sceneMediaUrl(active.poster.previewId ?? active.poster.id) : undefined} className="mx-auto max-h-[65vh] w-full rounded-lg bg-black"
        onLoadedMetadata={() => { const el = video.current; if (!el) return; if (source && Number.isFinite(el.duration)) setDuration(el.duration); el.currentTime = Math.max(0, pendingTime.current - offset); setPreviewRequested(false); if (playWhenLoaded.current) { playWhenLoaded.current = false; void el.play().catch(() => {}); } }}
        onTimeUpdate={() => { if (video.current && previewEnd.current != null && video.current.currentTime + offset >= previewEnd.current) { video.current.pause(); previewEnd.current = null; } }} />
      <div className="mt-3 flex flex-wrap gap-2"><button className={buttonClass} onClick={markCurrent}><Scissors size={15} />ここを保存範囲にする</button><button className={buttonClass} onClick={() => { void screenshot().catch(() => setError("このコマを保存できませんでした")); }}><Camera size={15} />このコマを保存</button></div>
      {editable && <div className="mt-4 border-t border-slate-100 pt-4">
        <p className="text-sm font-medium">スマホに保存する範囲</p><p className="mt-1 text-xs text-slate-500">必要な範囲だけ保存して、細かい編集はスマホで。1 本 {MAX_EXPORT_SECONDS} 秒まで選べます。</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-600">開始（秒）<input type="number" min={0} step={.1} max={duration ?? undefined} value={start} onChange={(e) => setStart(Number(e.target.value))} className="mt-1 block min-h-10 w-28 rounded-lg border border-slate-300 px-3 text-sm" /></label>
          <label className="text-xs text-slate-600">終了（秒）<input type="number" min={0} step={.1} max={duration ?? undefined} value={end} onChange={(e) => setEnd(Number(e.target.value))} className="mt-1 block min-h-10 w-28 rounded-lg border border-slate-300 px-3 text-sm" /></label>
          <button className={buttonClass} onClick={() => setStart(Math.round(((video.current?.currentTime ?? 0) + offset) * 10) / 10)}>開始を今の位置に</button>
          <button className={buttonClass} onClick={() => setEnd(Math.round(((video.current?.currentTime ?? 0) + offset) * 10) / 10)}>終了を今の位置に</button>
          <button className={buttonClass} disabled={!rangeValid} onClick={() => { previewEnd.current = end; playWhenLoaded.current = true; setPreviewRequested(true); seek(start, true); }}><Play size={15} />範囲を確認</button>
          <button className={buttonClass} disabled={!rangeValid || busy} onClick={() => transition(async () => {
            setError(null); const result = await exportVideoScene(data.asset.id, start, end);
            if (!result.ok) { setError(result.error); return; }
            try { await refresh(); } catch (e) { setError((e as Error).message); }
          })}>この範囲の動画を準備</button>
        </div>
        <p className="mt-2 text-xs text-slate-500">{rangeValid ? `${sceneTime(start)}–${sceneTime(end)} · ${(end - start).toFixed(1)} 秒${estimated != null ? ` · 元動画の容量からの目安 ${mediaSize(estimated)}（保存時は実容量を表示）` : ""}` : `開始・終了を動画内の ${MAX_EXPORT_SECONDS} 秒以内の範囲にしてください`}</p>
        {duration == null && <p className="mt-2 text-xs text-slate-500">元動画を再生すると、長さを確認して範囲を選べます。場面候補の生成を待つ必要はありません。</p>}
      </div>}
    </div>

    {data.exports.length > 0 && <section className="rounded-xl border border-slate-200 bg-white p-4"><h2 className="text-sm font-semibold">保存用に準備した動画</h2><p className="mt-1 text-xs text-slate-500">同じ動画のこのページをスマホで開くと、準備済みの範囲を保存できます。</p><ul className="mt-3 space-y-3">{data.exports.map((e) => <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{sceneTime(e.start)}–{sceneTime(e.end)} · {(e.end - e.start).toFixed(1)} 秒</span>{e.file ? <SceneDownloadButton file={e.file} filename={`${data.asset.id}-${e.start}-${e.end}.mp4`} compact /> : <span className="text-xs text-slate-500">{L[e.status as keyof typeof L] ?? e.status}</span>}</li>)}</ul></section>}

    <section><h2 className="text-lg font-semibold">{L.browse}</h2><p className="mt-1 text-sm text-slate-500">表紙から場面を開くか、スクショだけを保存できます。小さく写る場面も含めています。</p>
      {!data.scenes.length ? <p className="py-10 text-center text-sm text-slate-500">{data.task?.status === "ready" ? "本人として拾えた場面がありませんでした。元動画から気になるコマを保存できます。" : "場面候補はまだありません。元動画を見ながら、気になるコマを保存することもできます。"}</p>
        : <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{data.scenes.map((s) => <article key={s.id} className={`overflow-hidden rounded-xl border bg-white ${s.id === active?.id ? "border-sky-600 ring-1 ring-sky-600" : "border-slate-200"}`}>
          <button type="button" onClick={() => choose(s)} className="relative block aspect-video w-full bg-slate-950" aria-label={`${sceneTime(s.start)} からの場面を開く`}>
            <img src={sceneMediaUrl(s.poster.previewId ?? s.poster.id)} alt="場面の表紙" loading="lazy" className="h-full w-full object-contain" />
            <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-xs text-white">{s.video ? "▶ 場面を再生" : "スクショ"} · {sceneTime(s.start)}</span>
          </button><div className="space-y-3 p-3"><div className="flex items-center justify-between text-sm"><strong>{sceneTime(s.start)}–{sceneTime(s.end)}</strong><span className="text-xs text-slate-500">{s.shots.length} 枚</span></div>
            {s.video && <SceneDownloadButton file={s.video} filename={`${data.asset.id}-${s.start}-${s.end}.mp4`} label={`${Math.round(s.end - s.start)} 秒を保存`} compact />}
            <div className="flex gap-2 overflow-x-auto pb-1">{s.shots.map((shot) => <div key={`${shot.media.id}:${shot.time}`} className="w-32 shrink-0 space-y-1"><button className="block w-full rounded border border-slate-200" aria-label={`${sceneTime(shot.time)} のコマを表示`} onClick={() => { choose(s); seek(shot.time, true); }}><img src={sceneMediaUrl(shot.media.previewId ?? shot.media.id)} alt={`${sceneTime(shot.time)} のスクショ`} loading="lazy" className="aspect-video w-full object-contain" /></button><SceneDownloadButton file={shot.media} filename={`${data.asset.id}-${shot.time}s.jpg`} label={sceneTime(shot.time)} compact /></div>)}</div>
          </div></article>)}</div>}
    </section>
  </div>;
}
