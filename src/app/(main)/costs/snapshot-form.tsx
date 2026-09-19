"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { LLM_PROVIDER_LABELS } from "@/lib/utils";
import {
  CURRENCIES,
  CURRENCY_LABELS,
  DEFAULT_UNITS_PER_USD,
  type Currency,
} from "@/lib/costs/currency";
import type { LlmProvider } from "@prisma/client";
import { addCreditSnapshotAction, ingestCostsNowAction, type CostActionState } from "./actions";

/**
 * 残高スナップショットの入力と、プロバイダからの手動取り込み。**admin のみに出す。**
 * 残高は各社のダッシュボードで目視した値をそのまま入れる。
 */
export function SnapshotForm({ providers }: { providers: LlmProvider[] }) {
  const [provider, setProvider] = useState<string>(providers[0] ?? "openai");
  const [balance, setBalance] = useState("");
  // Gemini は Google Cloud の請求通貨が円のことがある。見たままの額を入れてもらう
  const [currency, setCurrency] = useState<Currency>("USD");
  const [unitsPerUsd, setUnitsPerUsd] = useState(String(DEFAULT_UNITS_PER_USD.JPY));
  const [note, setNote] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [state, setState] = useState<CostActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isPending || !balance) return;
    startTransition(async () => {
      const r = await addCreditSnapshotAction({
        provider,
        amount: balance,
        currency,
        unitsPerUsd: currency === "USD" ? "1" : unitsPerUsd,
        observedAt,
        note,
      });
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
        <span className="font-medium">円で表示される場合は通貨を JPY にしてください</span>
        （社内の集計は USD なので、レートで換算して保存します）。
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
          <span className="text-xs text-slate-500">残高</span>
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
          <span className="text-xs text-slate-500">通貨</span>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
            className="border border-slate-300 rounded px-2 py-1.5 text-sm"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {CURRENCY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        {currency !== "USD" && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">1 USD = ? {currency}</span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={unitsPerUsd}
              onChange={(e) => setUnitsPerUsd(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-sm w-28"
            />
          </label>
        )}
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
