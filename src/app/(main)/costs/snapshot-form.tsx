"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { LLM_PROVIDER_LABELS } from "@/lib/utils";
import type { LlmProvider } from "@prisma/client";
import { addCreditSnapshotAction, ingestCostsNowAction, type CostActionState } from "./actions";

/**
 * 残高スナップショットの入力と、プロバイダからの手動取り込み。**admin のみに出す。**
 * 残高は各社のダッシュボードで目視した値をそのまま入れる。
 */
export function SnapshotForm({ providers }: { providers: LlmProvider[] }) {
  const [provider, setProvider] = useState<string>(providers[0] ?? "openai");
  const [balance, setBalance] = useState("");
  const [note, setNote] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [state, setState] = useState<CostActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isPending || !balance) return;
    startTransition(async () => {
      const r = await addCreditSnapshotAction({ provider, balanceUsd: balance, observedAt, note });
      setState(r);
      if (r.ok) {
        setBalance("");
        setNote("");
        setObservedAt("");
      }
    });
  }

  return (
    <form onSubmit={submit} className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-1">残高を記録する</h2>
      <p className="text-xs text-slate-500 mb-3">
        各社のダッシュボードで見た残高をそのまま入れてください。入金したら「入金後の残高」を入れ直します。
        以降の支出はこの行を起点に引かれます。
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">プロバイダ</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5 text-sm"
          >
            {providers.map((p) => (
              <option key={p} value={p}>
                {LLM_PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">残高 (USD)</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            placeholder="25.00"
            className="border border-slate-300 rounded px-2 py-1.5 text-sm w-32"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">観測日時 (空なら今)</span>
          <input
            type="datetime-local"
            value={observedAt}
            onChange={(e) => setObservedAt(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-40">
          <span className="text-xs text-slate-500">メモ (任意)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="$20 入金後"
            maxLength={200}
            className="border border-slate-300 rounded px-2 py-1.5 text-sm w-full"
          />
        </label>
        <button
          type="submit"
          disabled={isPending || !balance}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
        >
          {isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          記録
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            if (isPending) return;
            startTransition(async () => setState(await ingestCostsNowAction()));
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={14} />
          今すぐ取り込む
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
