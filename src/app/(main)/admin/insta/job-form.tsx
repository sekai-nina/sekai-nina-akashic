"use client";

import { useState, useTransition } from "react";
import { Loader2, RefreshCw, Send } from "lucide-react";
import { createInstaJobAction, tickInstaJobsAction, type InstaActionState } from "./actions";

/**
 * story ジョブを手で作る (#178)。bot を経ずに iPad 側 (Pushcut → ラッパー Shortcut →
 * Instagram Download → アップロード) が通るかを確かめる入口。
 */
export function JobForm() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<InstaActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isPending || !url.trim()) return;
    startTransition(async () => {
      const r = await createInstaJobAction({ url });
      setState(r);
      if (r.ok) setUrl("");
    });
  }

  function tick() {
    if (isPending) return;
    startTransition(async () => setState(await tickInstaJobsAction()));
  }

  return (
    <form onSubmit={submit} className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-1">story を iPad に取りに行かせる</h2>
      <p className="text-xs text-slate-500 mb-3">
        通常は insta-watch が story を検知したときに自動で作られます。ここからは
        <span className="font-medium text-slate-700">手動で 1 件</span>作れます
        （URL でもハンドルでも可）。iPad は 1 台なので、前のジョブが終わるまで次は送りません。
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 flex-1 min-w-64">
          <span className="text-xs text-slate-500">story の URL またはハンドル</span>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.instagram.com/stories/hinatazaka46/"
            className="border border-slate-300 rounded px-2 py-1.5 text-sm w-full font-mono"
          />
        </label>
        <button
          type="submit"
          disabled={isPending || !url.trim()}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
        >
          {isPending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          送る
        </button>
        <button
          type="button"
          onClick={tick}
          disabled={isPending}
          title="失効したジョブを片付け、取り残された pending を送り直す"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded border border-slate-300 text-slate-600 text-sm hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={14} />
          キューを進める
        </button>
      </div>
      {state && (
        <p className={`mt-3 text-xs ${state.ok ? "text-emerald-700" : "text-red-700"}`}>
          {state.ok ? state.message : state.error}
        </p>
      )}
    </form>
  );
}
