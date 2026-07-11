"use client";

import { useEffect } from "react";
import { Highlighter } from "lucide-react";

/**
 * 言及ハイライト（?hl=nina）有効時のバナー（v2.4 追加要望）。
 * マウント時に最初の <mark data-hl="nina"> へスムーズスクロールする
 * （長いブログで言及が下部にあるケースのため）。
 */
export function NinaHighlightBanner({ count }: { count: number }) {
  useEffect(() => {
    if (count === 0) return;
    // レイアウト確定後にスクロール（画像等で多少ずれるのは許容）
    const t = setTimeout(() => {
      document
        .querySelector('mark[data-hl="nina"]')
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    return () => clearTimeout(t);
  }, [count]);

  return (
    <div
      className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
        count > 0
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-slate-200 bg-slate-50 text-slate-500"
      }`}
    >
      <Highlighter size={14} className="shrink-0" />
      {count > 0 ? (
        <span>
          坂井新奈への言及 <span className="font-semibold tabular-nums">{count}</span>{" "}
          箇所をハイライト中
        </span>
      ) : (
        <span>
          本文中に一致テキストは見つかりませんでした（エンティティリンク等による言及判定の可能性）
        </span>
      )}
    </div>
  );
}
