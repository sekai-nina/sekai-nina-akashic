"use client";

import { useOptimistic, useState, useTransition } from "react";
import { NINA_APPEARANCE_LABELS } from "@/lib/utils";
import { NINA_APPEARANCES, type NinaAppearance } from "@/lib/nina";
import { setAssetNinaAppearance } from "./nina-appearance-actions";

const activeColors: Record<NinaAppearance, string> = {
  appears: "bg-purple-600 text-white border-purple-600",
  absent: "bg-slate-600 text-white border-slate-600",
  unchecked: "bg-amber-100 text-amber-800 border-amber-300",
};

/**
 * 坂井新奈が出ているか (#261)。出ている = 坂井新奈「出演」を紐づける / 出ていない = 確認して出ていない。
 * Discord bot の ✅ / ❌ と同じものを画面から付け外しする
 */
export function NinaAppearancePanel({
  assetId,
  initial,
  editable,
}: {
  assetId: string;
  initial: NinaAppearance;
  editable: boolean;
}) {
  const [current, setCurrent] = useOptimistic(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleChange(to: NinaAppearance) {
    if (to === current) return;
    setError(null);
    startTransition(async () => {
      setCurrent(to);
      try {
        const res = await setAssetNinaAppearance(assetId, to);
        if (res.error) setError(res.error);
      } catch {
        // 想定外の失敗でページごとエラー画面にしない。楽観更新は遷移の終わりで元に戻る
        setError("記録に失敗しました。時間をおいてもう一度試してください");
      }
    });
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 id="nina-appearance-heading" className="text-sm font-semibold text-slate-700 mb-3">坂井新奈の出演</h2>
      {editable ? (
        <div role="group" aria-labelledby="nina-appearance-heading" className="flex gap-1.5 flex-wrap">
          {NINA_APPEARANCES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={pending}
              onClick={() => handleChange(s)}
              aria-pressed={current === s}
              className={`border px-3 py-1.5 rounded text-sm transition-colors disabled:opacity-60 ${
                current === s ? activeColors[s] : "border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {NINA_APPEARANCE_LABELS[s]}
            </button>
          ))}
        </div>
      ) : (
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium border ${activeColors[current]}`}>
          {NINA_APPEARANCE_LABELS[current]}
        </span>
      )}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
