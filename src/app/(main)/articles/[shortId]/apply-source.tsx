"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { ARTICLE_SOURCE_STATUS_LABELS } from "@/lib/utils";
import { applyArticleSourceAction } from "../actions";

/**
 * pending の紐づけを「反映済み」にする。**公開を決める操作** なので 1 段の確認を挟む
 * (次の push でこの出典の label / ref が公開リポジトリに出る)。
 *
 * 成功すると Server Action が `?applied=<n>` 付きで詳細へ redirect し、ページ側が
 * 「本文に ^[n] を書く」バナーを出す。ここに出すのは失敗の理由だけ。
 */
export function ApplySource({
  id,
  shortId,
  updatedAt,
}: {
  id: string;
  shortId: string;
  /** ページ描画時の Article.updatedAt (ISO)。楽観ロックに使う */
  updatedAt: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () =>
    startTransition(async () => {
      // 成功時は redirect されるのでここには戻らない
      const result = await applyArticleSourceAction(id, shortId, updatedAt);
      setError(result.error);
      setConfirming(false);
    });

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
      {confirming ? (
        <>
          <span className="text-slate-600">次の push で公開されます。</span>
          <button
            type="button"
            // 押した「反映済みにする」が消えてフォーカスが body に落ちるので、確認ボタンに移す
            autoFocus
            disabled={isPending}
            onClick={run}
            onKeyDown={(e) => {
              if (e.key === "Escape") setConfirming(false);
            }}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap"
          >
            {isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            反映する
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => setConfirming(false)}
            className="px-1.5 py-0.5 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap"
          >
            キャンセル
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="px-1.5 py-0.5 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50 whitespace-nowrap"
        >
          {ARTICLE_SOURCE_STATUS_LABELS.applied}にする
        </button>
      )}
      {error && <span className="text-red-600">{error}</span>}
    </span>
  );
}
