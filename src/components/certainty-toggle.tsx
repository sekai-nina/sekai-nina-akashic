"use client";

import type { PlaceCertainty } from "@prisma/client";
import { PLACE_CERTAINTY_HINTS, PLACE_CERTAINTY_LABELS } from "@/lib/utils";

const CERTAINTIES: PlaceCertainty[] = ["confirmed", "likely"];

/**
 * 訪問の確度 (確定 / ほぼ確定、#333) の切り替え。記事の聖地欄と企画の場所候補で使う。
 * スマホでも押しやすい高さにし、選んだ方の説明を下に出す (title はタッチでは出ないため)
 */
export function CertaintyToggle({
  value,
  onChange,
  disabled,
}: {
  value: PlaceCertainty;
  onChange: (c: PlaceCertainty) => void;
  disabled: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[11px] text-slate-400">訪問の確度</span>
      <span className="inline-flex rounded border border-slate-200 overflow-hidden" role="group" aria-label="訪問の確度">
        {CERTAINTIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            disabled={disabled}
            aria-pressed={value === c}
            title={PLACE_CERTAINTY_HINTS[c]}
            className={`px-2.5 py-1.5 sm:px-2 sm:py-0.5 text-xs sm:text-[11px] disabled:opacity-50 ${
              value === c
                ? c === "likely"
                  ? "bg-amber-100 text-amber-900"
                  : "bg-slate-700 text-white"
                : "bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            {PLACE_CERTAINTY_LABELS[c]}
          </button>
        ))}
      </span>
    </span>
  );
}

/** 「ほぼ確定」の理由の入力欄の共通の見た目 (iOS で拡大されないよう、スマホでは 16px) */
export const CERTAINTY_NOTE_INPUT =
  "flex-1 min-w-[12rem] border border-slate-300 rounded px-2 py-1.5 sm:py-0.5 text-base sm:text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50";

export const CERTAINTY_NOTE_PLACEHOLDER = "ほぼ確定の理由 (サイトにも出る) 例: おみくじを引いたとだけ。かき氷屋の周りの神社はここだけ";
