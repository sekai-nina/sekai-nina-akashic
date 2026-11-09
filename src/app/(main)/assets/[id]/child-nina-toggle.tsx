"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { NINA_APPEARANCE_LABELS, cn } from "@/lib/utils";
import type { NinaAppearance } from "@/lib/nina";
import { markUncheckedChildrenAbsent, setAssetNinaAppearance } from "./nina-appearance-actions";

export interface ChildNinaState {
  appearance: NinaAppearance;
  /** 坂井新奈が著者 (本人のブログ画像など)。「未確認」に戻せない */
  author: boolean;
}

/** サムネイルの枠の色。出ている = 紫 / 出ていない = 灰 / 未確認 = 既定 */
export function ninaFrameClass(appearance: NinaAppearance | undefined): string {
  if (appearance === "appears") return "ring-2 ring-purple-500";
  if (appearance === "absent") return "opacity-50";
  return "";
}

/**
 * 子アセットのサムネイルの下に出す「出ている / 出ていない」(#377)。
 * 押している方をもう一度押すと「未確認」に戻す (著者のアセットは戻せないので何もしない)
 */
export function ChildNinaToggle({ assetId, state }: { assetId: string; state: ChildNinaState }) {
  const [current, setCurrent] = useOptimistic(state.appearance);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function press(target: "appears" | "absent") {
    const to: NinaAppearance = current === target ? (state.author ? target : "unchecked") : target;
    if (to === current) return;
    setError(null);
    startTransition(async () => {
      setCurrent(to);
      try {
        const res = await setAssetNinaAppearance(assetId, to);
        if (res.error) setError(res.error);
      } catch {
        setError("記録に失敗しました");
      }
    });
  }

  return (
    <div className="mt-1">
      <div role="group" aria-label="坂井新奈の出演" className="flex gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={() => press("appears")}
          aria-pressed={current === "appears"}
          title={NINA_APPEARANCE_LABELS.appears}
          className={cn(
            "flex-1 h-6 inline-flex items-center justify-center gap-0.5 rounded border text-[11px] disabled:opacity-60",
            current === "appears"
              ? "bg-purple-600 text-white border-purple-600"
              : "border-slate-200 text-slate-500 hover:bg-slate-50"
          )}
        >
          <Check size={12} aria-hidden />
          出演
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => press("absent")}
          aria-pressed={current === "absent"}
          title={NINA_APPEARANCE_LABELS.absent}
          className={cn(
            "flex-1 h-6 inline-flex items-center justify-center gap-0.5 rounded border text-[11px] disabled:opacity-60",
            current === "absent"
              ? "bg-slate-600 text-white border-slate-600"
              : "border-slate-200 text-slate-500 hover:bg-slate-50"
          )}
        >
          <X size={12} aria-hidden />
          なし
        </button>
      </div>
      {error && <p className="mt-0.5 text-[10px] text-red-600">{error}</p>}
    </div>
  );
}

/** 子アセットの出演の集計と、「未確認」をまとめて「出ていない」にするボタン (#377) */
export function ChildNinaSummary({
  parentId,
  counts,
  editable,
}: {
  parentId: string;
  counts: Record<NinaAppearance, number>;
  editable: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function markRestAbsent() {
    if (!confirm(`未確認の ${counts.unchecked} 件をすべて「${NINA_APPEARANCE_LABELS.absent}」にしますか？`)) return;
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await markUncheckedChildrenAbsent(parentId);
        setMessage(res.error ?? `${res.count ?? 0} 件を「${NINA_APPEARANCE_LABELS.absent}」にしました`);
      } catch {
        setMessage("記録に失敗しました。時間をおいてもう一度試してください");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-xs text-slate-500">
      <span>坂井新奈:</span>
      <span className="text-purple-700">{NINA_APPEARANCE_LABELS.appears} {counts.appears}</span>
      <span>{NINA_APPEARANCE_LABELS.absent} {counts.absent}</span>
      <span className="text-amber-700">{NINA_APPEARANCE_LABELS.unchecked} {counts.unchecked}</span>
      {editable && counts.unchecked > 0 && (
        <button
          type="button"
          disabled={pending}
          onClick={markRestAbsent}
          className="ml-auto border border-slate-300 rounded px-2 py-1 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {pending ? "記録中…" : `未確認をすべて「${NINA_APPEARANCE_LABELS.absent}」にする`}
        </button>
      )}
      {message && <span className="w-full text-slate-600">{message}</span>}
    </div>
  );
}
