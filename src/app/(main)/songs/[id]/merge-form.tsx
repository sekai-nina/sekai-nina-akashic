"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { mergeSongsAction } from "../actions";

const inputCls =
  "px-2 py-1 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";

export function MergeForm({
  sourceId,
  sourceTitle,
  candidates,
}: {
  sourceId: string;
  sourceTitle: string;
  candidates: { id: string; title: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [targetId, setTargetId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const target = candidates.find((c) => c.id === targetId);

  function merge() {
    if (!target) return;
    if (!confirm(`「${sourceTitle}」を「${target.title}」に統合して消します。よろしいですか？`)) return;
    setMsg("統合中…");
    startTransition(async () => {
      const res = await mergeSongsAction(sourceId, targetId);
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      router.push(`/songs/${targetId}`);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={inputCls + " w-72"}
        value={targetId}
        onChange={(e) => setTargetId(e.target.value)}
        aria-label="統合先の曲"
      >
        <option value="">統合先を選ぶ</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={merge}
        disabled={pending || !targetId}
        className="h-8 px-3 rounded-md text-xs text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-40"
      >
        この曲を統合先に寄せて消す
      </button>
      {msg && (
        <span role="status" className="text-xs text-slate-500">
          {msg}
        </span>
      )}
    </div>
  );
}
