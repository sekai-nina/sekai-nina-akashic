"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, PlayCircle } from "lucide-react";
import type { EpisodeStatus, ShowEpisodeRow, TargetStatus } from "@/lib/domain/show-progress";
import { SHOWS, type ShowKey } from "@/lib/progress/shows";
import { ARTICLE_TYPE_LABELS, SHOW_EPISODE_STATUS_LABELS, cn } from "@/lib/utils";
import { ListRowForm } from "./list-row-form";
import { setShowProgressAction } from "./show-actions";

const FILTERS: EpisodeStatus[] = ["todo", "partial", "done", "excluded"];

const STATUS_STYLE: Record<EpisodeStatus, string> = {
  todo: "border-slate-200 bg-slate-50 text-slate-500",
  partial: "border-amber-200 bg-amber-50 text-amber-700",
  done: "border-emerald-200 bg-emerald-50 text-emerald-700",
  excluded: "border-slate-200 bg-white text-slate-400",
};

const BUTTON = "inline-flex items-center gap-1 h-6 px-2 rounded-md border text-[11px] disabled:opacity-50";

export function ShowList({
  showKey,
  rows,
  editable,
  canPublish,
}: {
  showKey: ShowKey;
  rows: ShowEpisodeRow[];
  editable: boolean;
  /** 行を足したあと push できる (admin) */
  canPublish: boolean;
}) {
  const [filter, setFilter] = useState<EpisodeStatus | "all">("todo");
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
            {f === "all" ? "すべて" : SHOW_EPISODE_STATUS_LABELS[f]}
            <span className="tabular-nums opacity-70">{f === "all" ? rows.length : counts[f]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-lg p-10 text-center text-sm text-slate-500">
          該当する回はありません
        </div>
      ) : (
        <ul className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {shown.map((r) => (
            <EpisodeRow key={r.episode} showKey={showKey} row={r} editable={editable} canPublish={canPublish} />
          ))}
        </ul>
      )}
    </>
  );
}

function EpisodeRow({
  showKey,
  row,
  editable,
  canPublish,
}: {
  showKey: ShowKey;
  row: ShowEpisodeRow;
  editable: boolean;
  canPublish: boolean;
}) {
  const show = SHOWS[showKey];
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // 行を足すフォーム。本編の行が済んだあとも番外編の行は足せる (ひななり)
  const [adding, setAdding] = useState<"all" | "extras" | null>(null);

  function set(target: "list_row" | "articles", status: "done" | "excluded" | null, note = "") {
    setError(null);
    startTransition(async () => {
      const res = await setShowProgressAction(showKey, row.episode, target, status, note);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  const notAppearing = row.status === "excluded";

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px]", STATUS_STYLE[row.status])}>
          {SHOW_EPISODE_STATUS_LABELS[row.status]}
        </span>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">#{row.episode}</span>
        {row.videos[0] ? (
          <Link href={`/assets/${row.videos[0].assetId}`} className="text-sm text-slate-800 truncate hover:underline">
            {row.title}
          </Link>
        ) : (
          <span className="text-sm text-slate-800 truncate">{row.title}</span>
        )}
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400 shrink-0" />}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
        <span className="tabular-nums mr-1">{row.date ?? "日付不明"}</span>
        {/* 動画のアセットへ。見ながらチェックするので目立たせる */}
        {row.videos.map((v) => (
          <Link
            key={v.assetId}
            href={`/assets/${v.assetId}`}
            title={v.title}
            className="inline-flex items-center gap-1 h-6 max-w-full sm:max-w-[20rem] px-2 rounded-md border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100"
          >
            <PlayCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="shrink-0">{v.extra ? (show.extraLabel ?? "番外編") : "本編"}</span>
            {v.subtitle !== row.title && <span className="truncate">{v.subtitle}</span>}
          </Link>
        ))}
      </div>

      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {/* 出演一覧の行 */}
        <Target label="出演一覧" status={row.listRow.status} excludedLabel="出演なし">
          {row.listRow.article ? (
            <>
              <Link href={`/articles/${row.listRow.article.shortId}`} className="hover:underline truncate">
                {row.listRow.article.title}
              </Link>
              {editable && row.videos.some((v) => v.extra) && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setAdding((v) => (v ? null : "extras"))}
                  className={cn(BUTTON, "border-slate-200 text-slate-600 hover:bg-slate-50")}
                >
                  {show.extraLabel ?? "番外編"}の行を足す
                </button>
              )}
            </>
          ) : notAppearing ? (
            editable && (
              <button type="button" disabled={pending} onClick={() => set("list_row", null)} className={cn(BUTTON, "border-slate-200 text-slate-600 hover:bg-slate-50")}>
                出演なしを戻す
              </button>
            )
          ) : (
            <>
              {editable ? (
                <button
                  type="button"
                  disabled={pending || row.videos.length === 0}
                  onClick={() => setAdding((v) => (v ? null : "all"))}
                  className={cn(BUTTON, "border-slate-900 bg-slate-900 text-white hover:bg-slate-800")}
                >
                  行を足す
                </button>
              ) : (
                <span className="text-slate-400">{show.listHint}</span>
              )}
              {editable && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => set("list_row", "excluded", "出演なし")}
                  className={cn(BUTTON, "border-slate-200 text-slate-600 hover:bg-slate-50")}
                >
                  出ていない回
                </button>
              )}
            </>
          )}
        </Target>

        {/* 記事化 */}
        <Target label="記事化" status={row.articles.status} doneLabel="見終わった" excludedLabel="出演なし">
          {row.articles.items.map((a) => (
            <Link key={a.shortId} href={`/articles/${a.shortId}`} className="hover:underline truncate max-w-[14rem]" title={a.title}>
              {a.type ? `${ARTICLE_TYPE_LABELS[a.type as keyof typeof ARTICLE_TYPE_LABELS] ?? a.type}: ` : ""}
              {a.title}
            </Link>
          ))}
          {row.articles.items.length === 0 && !notAppearing && <span className="text-slate-400">記事なし</span>}
          {editable && !notAppearing && (
            row.articles.status === "done" ? (
              <button type="button" disabled={pending} onClick={() => set("articles", null)} className={cn(BUTTON, "border-slate-200 text-slate-600 hover:bg-slate-50")}>
                戻す
              </button>
            ) : (
              <button type="button" disabled={pending} onClick={() => set("articles", "done")} className={cn(BUTTON, "border-slate-900 bg-slate-900 text-white hover:bg-slate-800")}>
                見終わった
              </button>
            )
          )}
        </Target>
      </div>
      {adding && (
        <ListRowForm
          showKey={showKey}
          videos={adding === "extras" ? row.videos.filter((v) => v.extra) : row.videos}
          canPublish={canPublish}
          onDone={() => {
            setAdding(null);
            router.refresh();
          }}
          onCancel={() => setAdding(null)}
        />
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}

function Target({
  label,
  status,
  doneLabel = "済",
  excludedLabel,
  children,
}: {
  label: string;
  status: TargetStatus;
  doneLabel?: string;
  excludedLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-slate-100 bg-slate-50/50 px-2 py-1.5 text-xs text-slate-600 min-w-0">
      <span className="font-medium text-slate-700">{label}</span>
      <span
        className={cn(
          "rounded px-1.5 py-px text-[10px]",
          status === "done" ? "bg-emerald-100 text-emerald-700" : status === "excluded" ? "bg-slate-100 text-slate-400" : "bg-amber-50 text-amber-700"
        )}
      >
        {status === "done" ? doneLabel : status === "excluded" ? excludedLabel : "未"}
      </span>
      {children}
    </div>
  );
}
