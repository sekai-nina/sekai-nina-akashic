"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, Loader2 } from "lucide-react";
import type { BlogQuoteRow, BlogQuoteStatus } from "@/lib/domain/blog-quotes";
import { BLOG_QUOTE_STATUS_LABELS, cn } from "@/lib/utils";
import { setBlogQuoteExcludedAction, startBlogQuoteAction } from "./actions";

const FILTERS: BlogQuoteStatus[] = ["todo", "in_progress", "done", "excluded"];

const STATUS_STYLE: Record<BlogQuoteStatus, string> = {
  todo: "border-slate-200 bg-slate-50 text-slate-500",
  in_progress: "border-amber-200 bg-amber-50 text-amber-700",
  done: "border-emerald-200 bg-emerald-50 text-emerald-700",
  excluded: "border-slate-200 bg-white text-slate-400",
};

const BUTTON = "inline-flex items-center gap-1 h-7 px-2.5 rounded-md border text-xs disabled:opacity-50";

export function BlogQuoteList({ rows, editable }: { rows: BlogQuoteRow[]; editable: boolean }) {
  const [filter, setFilter] = useState<BlogQuoteStatus | "all">("todo");
  const counts = Object.fromEntries(FILTERS.map((f) => [f, rows.filter((r) => r.status === f).length]));
  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter);

  return (
    <>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {[...FILTERS, "all" as const].map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "inline-flex items-center gap-1 h-7 px-2.5 rounded-full border text-xs",
              filter === f
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            )}
          >
            {f === "all" ? "すべて" : BLOG_QUOTE_STATUS_LABELS[f]}
            <span className="tabular-nums opacity-70">{f === "all" ? rows.length : counts[f]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-lg p-10 text-center text-sm text-slate-500">
          該当するブログはありません
        </div>
      ) : (
        <ul className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {shown.map((r) => (
            <BlogRow key={r.assetId} row={r} editable={editable} />
          ))}
        </ul>
      )}
    </>
  );
}

function BlogRow({ row, editable }: { row: BlogQuoteRow; editable: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [excluding, setExcluding] = useState(false);
  const [note, setNote] = useState("名言なし");

  function run(fn: () => Promise<{ ok: true; href?: string } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error);
      setExcluding(false);
      if (res.href) router.push(res.href);
      else router.refresh();
    });
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px]", STATUS_STYLE[row.status])}>
              {BLOG_QUOTE_STATUS_LABELS[row.status]}
            </span>
            <Link href={`/assets/${row.assetId}`} className="text-sm font-medium text-slate-900 truncate hover:underline">
              {row.title}
            </Link>
            <a href={row.url} target="_blank" rel="noreferrer" className="shrink-0 text-slate-400 hover:text-slate-600" title="ブログを開く">
              <ExternalLink size={12} />
            </a>
          </div>
          <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
            <span className="tabular-nums">{row.date ?? "日付不明"}</span>
            {row.article && (
              <>
                <Link href={`/articles/${row.article.shortId}`} className="hover:underline">
                  記事「{row.article.title}」
                </Link>
                <span>名言 {row.article.quoteCount}</span>
                {row.article.draft && <span className="text-amber-700">下書き</span>}
                {row.article.dirty && <span className="text-amber-700">未 push</span>}
              </>
            )}
            {row.dossier && <span>抜粋 {row.dossier.excerptCount}</span>}
            {row.status === "excluded" && row.note && <span>理由: {row.note}</span>}
          </div>
        </div>

        {editable && (
          <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
            {row.status === "todo" && (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => startBlogQuoteAction(row.assetId))}
                  className={cn(BUTTON, "border-slate-900 bg-slate-900 text-white hover:bg-slate-800")}
                >
                  記事を作る
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setExcluding((v) => !v)}
                  className={cn(BUTTON, "border-slate-200 text-slate-600 hover:bg-slate-50")}
                >
                  対象外
                </button>
              </>
            )}
            {row.status === "in_progress" && row.dossier && (
              <>
                <Link
                  href={`/assets/${row.assetId}?dossier=${row.dossier.id}`}
                  className={cn(BUTTON, "border-slate-200 text-slate-700 hover:bg-slate-50")}
                >
                  範囲を選ぶ
                </Link>
                <Link
                  href={`/dossiers/${row.dossier.id}/article`}
                  className={cn(BUTTON, "border-slate-900 bg-slate-900 text-white hover:bg-slate-800")}
                >
                  記事にする
                </Link>
              </>
            )}
            {row.article && (
              <Link
                href={`/quotes/${row.article.shortId}`}
                className={cn(BUTTON, "border-slate-200 text-slate-700 hover:bg-slate-50")}
              >
                名言を選ぶ
              </Link>
            )}
            {row.status === "excluded" && (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => setBlogQuoteExcludedAction(row.assetId, false, ""))}
                className={cn(BUTTON, "border-slate-200 text-slate-600 hover:bg-slate-50")}
              >
                対象外を戻す
              </button>
            )}
          </div>
        )}
      </div>

      {excluding && (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => setBlogQuoteExcludedAction(row.assetId, true, note));
          }}
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="理由 (任意)"
            className="h-7 flex-1 max-w-xs rounded-md border border-slate-200 px-2 text-xs"
          />
          <button type="submit" disabled={pending} className={cn(BUTTON, "border-slate-900 bg-slate-900 text-white")}>
            対象外にする
          </button>
        </form>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}
