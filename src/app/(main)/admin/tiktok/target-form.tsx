"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  DEFAULT_INTERVAL_MINUTES,
  INTERVAL_MAX_MINUTES,
  INTERVAL_MIN_MINUTES,
  NOTE_MAX,
  SOURCE_NAME_MAX,
} from "@/lib/tiktok/targets";
import {
  addTiktokTargetAction,
  deleteTiktokTargetAction,
  requeueFailedTiktokVideosAction,
  requeueTiktokVideoAction,
  toggleTiktokTargetAction,
  type TiktokActionState,
} from "./actions";

export function TargetForm() {
  const [handle, setHandle] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [official, setOfficial] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState(String(DEFAULT_INTERVAL_MINUTES));
  const [note, setNote] = useState("");
  const [state, setState] = useState<TiktokActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isPending || !handle.trim()) return;
    startTransition(async () => {
      const r = await addTiktokTargetAction({ handle, sourceName, official, intervalMinutes, note });
      setState(r);
      if (r.ok) {
        setHandle("");
        setSourceName("");
        setNote("");
      }
    });
  }

  return (
    <form onSubmit={submit} className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-1">監視対象を追加する</h2>
      <p className="text-xs text-slate-500 mb-3">
        <span className="font-medium">@ 付き・URL のまま貼っても大丈夫</span>です。
        追加した時点で見えている動画は「既知」として飛ばし、以降の新着だけ取り込みます
        （過去分は bot サーバで <span className="font-mono">tiktok-watch backfill</span>）。
        一度外したハンドルを入れ直すと、そのまま再開します。
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">ハンドル</span>
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="hinatazakanews"
            className="border border-slate-300 rounded px-2 py-1.5 text-sm w-48 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">出典エンティティ名（任意）</span>
          <input
            type="text"
            value={sourceName}
            onChange={(e) => setSourceName(e.target.value)}
            placeholder="日向坂46 TikTok"
            maxLength={SOURCE_NAME_MAX}
            className="border border-slate-300 rounded px-2 py-1.5 text-sm w-44"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">間隔（分）</span>
          <input
            type="number"
            min={INTERVAL_MIN_MINUTES}
            max={INTERVAL_MAX_MINUTES}
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5 text-sm w-24"
          />
        </label>
        <label className="flex items-center gap-1.5 pb-2 text-sm text-slate-700">
          <input type="checkbox" checked={official} onChange={(e) => setOfficial(e.target.checked)} />
          公式
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-40">
          <span className="text-xs text-slate-500">メモ（任意）</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={NOTE_MAX}
            className="border border-slate-300 rounded px-2 py-1.5 text-sm w-full"
          />
        </label>
        <button
          type="submit"
          disabled={isPending || !handle.trim()}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
        >
          {isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          追加
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

const SMALL_BUTTON =
  "text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50";

export function RowActions({
  id,
  enabled,
  handle,
  failedCount,
}: {
  id: string;
  enabled: boolean;
  handle: string;
  failedCount: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      {failedCount > 0 && (
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const r = await requeueFailedTiktokVideosAction(id);
              setMessage(r.ok ? r.message : r.error);
            })
          }
          className={SMALL_BUTTON}
        >
          失敗 {failedCount} 本を再試行
        </button>
      )}
      <button
        type="button"
        disabled={isPending}
        onClick={() => startTransition(async () => void (await toggleTiktokTargetAction(id, !enabled)))}
        className={SMALL_BUTTON}
      >
        {enabled ? "外す" : "再開"}
      </button>
      {/* 消すと動画の台帳も消える (アセットは残る)。まず「外す」を促し、削除は 2 段階にする */}
      {confirming ? (
        <>
          <button
            type="button"
            disabled={isPending}
            onClick={() => startTransition(async () => void (await deleteTiktokTargetAction(id)))}
            className="text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {handle} を削除
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={SMALL_BUTTON}>
            やめる
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-xs p-1 rounded text-slate-400 hover:text-red-600"
          aria-label="削除"
        >
          <Trash2 size={14} />
        </button>
      )}
      {message && <span className="w-full text-right text-xs text-slate-500">{message}</span>}
    </span>
  );
}

export function RequeueButton({ id, label }: { id: string; label: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const r = await requeueTiktokVideoAction(id);
            setError(r.ok ? null : r.error);
          })
        }
        className={`inline-flex items-center gap-1 ${SMALL_BUTTON}`}
      >
        {isPending ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
        {label}
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
