"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  addInstaTargetAction,
  deleteInstaTargetAction,
  toggleInstaTargetAction,
  type InstaActionState,
} from "./actions";

const TIERS = [
  { value: "hot", label: "高頻度（10 分）" },
  { value: "normal", label: "通常（18 分）" },
  { value: "cold", label: "低頻度（4 時間）" },
] as const;

export function TargetForm() {
  const [handle, setHandle] = useState("");
  const [tier, setTier] = useState<string>("normal");
  const [intervalMinutes, setIntervalMinutes] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<InstaActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isPending || !handle.trim()) return;
    startTransition(async () => {
      const r = await addInstaTargetAction({ handle, tier, intervalMinutes, note });
      setState(r);
      if (r.ok) {
        setHandle("");
        setIntervalMinutes("");
        setNote("");
      }
    });
  }

  return (
    <form onSubmit={submit} className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-1">監視対象を追加する</h2>
      <p className="text-xs text-slate-500 mb-3">
        <span className="font-medium">@ 付き・URL のまま貼っても大丈夫</span>です。
        一度外したハンドルを入れ直すと、そのまま再開します。
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">ハンドル</span>
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="hinatazaka46"
            className="border border-slate-300 rounded px-2 py-1.5 text-sm w-56 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">頻度</span>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5 text-sm"
          >
            {TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">間隔を明示（分・任意）</span>
          <input
            type="number"
            min="1"
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(e.target.value)}
            placeholder="既定に従う"
            className="border border-slate-300 rounded px-2 py-1.5 text-sm w-32"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-40">
          <span className="text-xs text-slate-500">メモ（任意）</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
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

export function RowActions({ id, enabled, handle }: { id: string; enabled: boolean; handle: string }) {
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() => startTransition(async () => void (await toggleInstaTargetAction(id, !enabled)))}
        className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      >
        {enabled ? "外す" : "再開"}
      </button>
      {/* 消すと履歴もメモも消えるので、まず「外す」を促し、削除は 2 段階にする */}
      {confirming ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() => startTransition(async () => void (await deleteInstaTargetAction(id)))}
          className="text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
        >
          {handle} を削除
        </button>
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
    </span>
  );
}
