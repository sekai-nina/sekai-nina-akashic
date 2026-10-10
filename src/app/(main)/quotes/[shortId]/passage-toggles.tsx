"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { QuotePassage } from "@/lib/quotes/featured-passages";
import { cn } from "@/lib/utils";
import { setQuotePassageAction } from "../actions";

export function PassageToggles({
  shortId,
  passages,
  editable,
}: {
  shortId: string;
  passages: QuotePassage[];
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(p: QuotePassage) {
    setError(null);
    setBusy(p.index);
    startTransition(async () => {
      const res = await setQuotePassageAction(shortId, p.index, !p.quoted, p.text);
      setBusy(null);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  if (passages.length === 0) {
    return <p className="mt-6 text-sm text-slate-500">本文に引用がありません。</p>;
  }

  return (
    <>
      {error && <p className="mt-4 text-xs text-red-600">{error}</p>}
      <ul className="mt-4 space-y-3">
        {passages.map((p) => (
          <li
            key={p.index}
            className={cn(
              "bg-white border rounded-lg p-3 flex gap-3",
              p.quoted ? "border-emerald-300" : "border-slate-200"
            )}
          >
            <blockquote className="flex-1 min-w-0 border-l-2 border-slate-200 pl-3 text-sm text-slate-700 whitespace-pre-wrap">
              {p.segments.map((s, i) => (
                <span key={i} className={s.quoted ? "bg-emerald-100 text-slate-900" : undefined}>
                  {s.text}
                </span>
              ))}
            </blockquote>
            <div className="shrink-0 flex flex-col items-end gap-1">
              {p.unbalanced ? (
                <span className="text-[11px] text-amber-700" title="引用をまたいで {q} が付いています">
                  編集画面で直す
                </span>
              ) : (
                editable && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => toggle(p)}
                    className={cn(
                      "inline-flex items-center gap-1 h-7 px-2.5 rounded-md border text-xs disabled:opacity-50",
                      p.quoted
                        ? "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
                        : "border-slate-200 text-slate-700 hover:bg-slate-50"
                    )}
                  >
                    {busy === p.index && <Loader2 className="h-3 w-3 animate-spin" />}
                    {p.quoted ? "名言集に載せる ✓" : "名言集に載せる"}
                  </button>
                )
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
