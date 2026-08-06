"use client";

import { useTransition } from "react";
import { Loader2, X } from "lucide-react";
import { removeArticleSourceAction } from "../actions";

/**
 * 紐づけの解除。取り込み由来の出典 (applied) も消せてしまうと記事の出典が
 * 壊れるので、呼び出し側で pending のものだけに出す。
 */
export function RemoveSource({ id, shortId }: { id: string; shortId: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      title="紐づけを外す"
      disabled={isPending}
      onClick={() => startTransition(() => removeArticleSourceAction(id, shortId))}
      className="inline-flex items-center justify-center w-5 h-5 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
    >
      {isPending ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
    </button>
  );
}
