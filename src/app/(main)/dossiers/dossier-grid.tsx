"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FileText, FolderSearch, Lock, Eye, Pencil, Search, ArrowRight, Inbox } from "lucide-react";
import { DOSSIER_LIST_LABELS as L, formatDate } from "@/lib/utils";

/**
 * ドシエ一覧のカードとタイトル絞り込み。
 *
 * #41 のバックフィルで記事 1 本につき 1 ドシエ (約 220 本) が増えたので、一覧が
 * 100 → 300 超になる。全件をサーバから受け取って、絞り込みだけクライアントで行う。
 */

const CLASSIFICATION_LABEL: Record<string, string> = {
  internal: "一般",
  confidential: "限定",
  restricted: "極秘",
};

const CLASSIFICATION_BADGE: Record<string, string> = {
  internal: "bg-blue-100 text-blue-700",
  confidential: "bg-orange-100 text-orange-700",
  restricted: "bg-red-100 text-red-700",
};

export interface DossierCardData {
  id: string;
  title: string;
  summary: string;
  classification: string;
  viewMode: string;
  editMode: string;
  ownerId: string;
  ownerName: string | null;
  itemCount: number;
  placeCount: number;
  updatedAt: string;
  /** 記事の素材ドシエなら、その記事の総数 (バッジ用。`articles` は検索用に先頭数件だけ) */
  articleCount: number;
  articles: { shortId: string; title: string }[];
}

/** 企画ごとの反映待ち (`dossier-sync-queue.ts`)。記事に載っていないクリップの数と、最後に入れた日時 */
export type PendingByDossier = Record<string, { count: number; at: string }>;

/**
 * 既定は未記事化。記事 0 本の企画 = まだ組み立て中のもの。
 * 反映待ち = 記事はあるが、記事に載っていないクリップが入っているもの
 */
const FILTERS = ["draft", "pending", "written", "all"] as const;
type Filter = (typeof FILTERS)[number];

export function DossierGrid({
  dossiers: baseDossiers,
  pending: pendingPromise,
  currentUserId,
  initialFilter,
}: {
  dossiers: DossierCardData[];
  /**
   * 反映待ちは全企画の記事と出典を突き合わせるので 1〜2 秒かかる。一覧を先に出し、届いたら埋める
   * (待つあいだ反映待ちの件数は「…」)
   */
  pending: Promise<PendingByDossier>;
  currentUserId: string;
  /** `?filter=` (記事画面の「反映待ちの一覧へ」が `pending` で戻ってくる) */
  initialFilter?: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(
    FILTERS.find((f) => f === initialFilter) ?? "draft"
  );
  const [pending, setPending] = useState<PendingByDossier | null>(null);
  useEffect(() => {
    let alive = true;
    pendingPromise.then(
      (p) => alive && setPending(p),
      (e: unknown) => {
        console.error("反映待ちの取得に失敗:", e);
        if (alive) setPending({});
      }
    );
    return () => {
      alive = false;
    };
  }, [pendingPromise]);
  const dossiers = useMemo(
    () =>
      baseDossiers.map((d) => ({
        ...d,
        pendingCount: pending?.[d.id]?.count ?? 0,
        pendingAt: pending?.[d.id]?.at ?? null,
      })),
    [baseDossiers, pending]
  );

  const writtenCount = useMemo(() => dossiers.filter((d) => d.articleCount > 0).length, [dossiers]);
  const pendingCount = useMemo(() => dossiers.filter((d) => d.pendingCount > 0).length, [dossiers]);
  const counts: Record<Filter, number> = {
    draft: dossiers.length - writtenCount,
    pending: pendingCount,
    written: writtenCount,
    all: dossiers.length,
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = dossiers.filter((d) => {
      if (filter === "written" && d.articleCount === 0) return false;
      if (filter === "draft" && d.articleCount > 0) return false;
      if (filter === "pending" && d.pendingCount === 0) return false;
      if (!q) return true;
      const hay = `${d.title}\n${d.summary}\n${d.articles.map((a) => a.title).join("\n")}`.toLowerCase();
      return hay.includes(q);
    });
    // 反映待ちは、クリップを入れたばかりのものから順に片付けられるよう新しい順
    if (filter === "pending") list.sort((a, b) => (b.pendingAt ?? "").localeCompare(a.pendingAt ?? ""));
    return list;
  }, [dossiers, query, filter]);

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center mb-4">
        <label className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="タイトル・記事名で絞り込む"
            className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
          />
        </label>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`px-3 py-1 rounded-full text-sm transition-colors ${
                filter === key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {L[key]} {key === "pending" && !pending ? "…" : counts[key]}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center">
          <FolderSearch className="h-10 w-10 mx-auto text-slate-300 mb-2" />
          <p className="text-sm text-slate-500">
            {dossiers.length === 0
              ? "まだ企画がありません。"
              : filter === "pending" && !pending
                ? "反映待ちを確かめています…"
                : "条件に合う企画はありません。"}
          </p>
          {dossiers.length > 0 && filter !== "all" && (
            <button
              type="button"
              onClick={() => setFilter("all")}
              className="mt-2 text-sm text-indigo-600 hover:underline"
            >
              すべての企画から探す
            </button>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((d) => {
          const isOwner = d.ownerId === currentUserId;
          // 反映待ちのタブからは記事の画面へ直行する (差分を見て追記するのが次の作業なので)
          const toArticle = filter === "pending";
          return (
            <Link
              key={d.id}
              href={toArticle ? `/dossiers/${d.id}/article` : `/dossiers/${d.id}`}
              className="block bg-white border border-slate-200 hover:border-indigo-300 rounded-lg p-4 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <h2 className="text-sm font-semibold text-slate-900 line-clamp-2 flex-1">
                  {d.title || "(無題)"}
                </h2>
                <span
                  className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${CLASSIFICATION_BADGE[d.classification] ?? "bg-slate-100 text-slate-600"}`}
                >
                  {CLASSIFICATION_LABEL[d.classification] ?? d.classification}
                </span>
              </div>
              {d.articleCount > 0 && (
                <div className="flex flex-wrap items-center gap-1 mb-2">
                  <p className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">
                    <FileText className="h-3 w-3" />
                    記事{d.articleCount > 1 ? ` ${d.articleCount} 本` : ""}
                  </p>
                  {d.pendingCount > 0 && (
                    <p className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800">
                      <Inbox className="h-3 w-3" />
                      {L.pendingBadge(d.pendingCount)}
                      {d.pendingAt ? ` · ${L.addedOn(formatDate(d.pendingAt))}` : ""}
                    </p>
                  )}
                </div>
              )}
              {d.summary && (
                <p className="text-xs text-slate-500 line-clamp-2 mb-3">{d.summary}</p>
              )}
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <div className="flex items-center gap-2">
                  <span>{d.itemCount} 件</span>
                  {d.placeCount > 0 && <span>· 場所 {d.placeCount}</span>}
                </div>
                <div className="flex items-center gap-1">
                  {d.viewMode === "private" ? <Lock className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  {d.editMode === "clearance" && <Pencil className="h-3 w-3" />}
                  {!isOwner && d.ownerName && (
                    <span className="ml-1 truncate max-w-[80px]">{d.ownerName}</span>
                  )}
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
                <span>更新 {formatDate(d.updatedAt)}</span>
                {toArticle && (
                  <span className="inline-flex items-center gap-0.5 text-indigo-700">
                    {L.toArticle} <ArrowRight className="h-3 w-3" />
                  </span>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
