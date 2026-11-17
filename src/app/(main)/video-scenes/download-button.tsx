"use client";

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { fetchSceneDownload, saveSceneBlob } from "@/lib/video-scenes/download";
import { mediaSize, type SceneMedia } from "@/lib/video-scenes/policy";

export function SceneDownloadButton({ file, filename, label = "保存", compact = false }: {
  file: SceneMedia; filename: string; label?: string; compact?: boolean;
}) {
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function download() {
    const abort = new AbortController();
    controller.current = abort;
    setProgress(0); setError(null);
    try {
      const blob = await fetchSceneDownload(file, abort.signal, setProgress);
      if (!abort.signal.aborted) saveSceneBlob(blob, filename);
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      if (controller.current === abort) { controller.current = null; setProgress(null); }
    }
  }
  return <div>
    <button type="button" onClick={download} disabled={progress != null} className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-sky-700 text-white disabled:opacity-60 ${compact ? "px-3 py-2 text-xs" : "px-4 py-2 text-sm"}`}>
      <Download size={15} />{progress == null ? `${label} · ${mediaSize(file.fileSize)}` : `取得中 ${progress}%`}
    </button>
    {progress != null && <button type="button" className="ml-2 min-h-10 text-xs text-slate-600" onClick={() => { controller.current?.abort(); setProgress(null); }}>中止</button>}
    {error && <p role="alert" className="mt-1 text-xs text-rose-700">{error}</p>}
  </div>;
}
