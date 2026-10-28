"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { NINA_APPEARANCE_LABELS, cn } from "@/lib/utils";
import { NINA_APPEARANCES, type NinaAppearance } from "@/lib/nina";
import { setAssetNinaAppearance } from "@/app/(main)/assets/[id]/nina-appearance-actions";

/**
 * クリップに坂井新奈が出ているか (#261) を、記事にする画面から付け外しする。
 * おでかけ記事の関連メディアは「出ている」ものを「坂井新奈が写っているもの」に分ける
 */
export function NinaAppearanceToggle({
  assetId,
  initial,
  author,
}: {
  assetId: string;
  initial: NinaAppearance;
  author: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useOptimistic(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function change(to: NinaAppearance) {
    if (to === current) return;
    setError(null);
    startTransition(async () => {
      setCurrent(to);
      try {
        const res = await setAssetNinaAppearance(assetId, to);
        if (res.error) setError(res.error);
        else router.refresh();
      } catch {
        setError("記録に失敗しました。時間をおいてもう一度試してください");
      }
    });
  }

  return (
    <div>
      <div role="group" aria-label="坂井新奈の出演" className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[11px] text-slate-500">坂井新奈が</span>
        {/* 本人の投稿は著者の紐づきを外せないので「未確認」は無い */}
        {NINA_APPEARANCES.filter((s) => !author || s !== "unchecked").map((s) => (
          <button
            key={s}
            type="button"
            disabled={pending}
            onClick={() => change(s)}
            aria-pressed={current === s}
            className={cn(
              "h-6 px-2 rounded border text-[11px] disabled:opacity-60",
              current === s
                ? s === "appears"
                  ? "bg-purple-600 text-white border-purple-600"
                  : "bg-slate-600 text-white border-slate-600"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            )}
          >
            {NINA_APPEARANCE_LABELS[s]}
          </button>
        ))}
      </div>
      {author && <p className="mt-0.5 text-[10px] text-slate-400">坂井新奈本人の投稿。写っていなければ「{NINA_APPEARANCE_LABELS.absent}」に</p>}
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
