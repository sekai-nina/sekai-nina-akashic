"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { FileText, FolderSearch, Lock, Eye, Pencil, Search } from "lucide-react";
import { formatDate } from "@/lib/utils";

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

type Filter = "all" | "article" | "other";

export function DossierGrid({ dossiers, currentUserId }: { dossiers: DossierCardData[]; currentUserId: string }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const articleCount = useMemo(() => dossiers.filter((d) => d.articleCount > 0).length, [dossiers]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return dossiers.filter((d) => {
      if (filter === "article" && d.articleCount === 0) return false;
      if (filter === "other" && d.articleCount > 0) return false;
      if (!q) return true;
      const hay = `${d.title}\n${d.summary}\n${d.articles.map((a) => a.title).join("\n")}`.toLowerCase();
      return hay.includes(q);
    });
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
        <div className="flex items-center gap-1 text-xs">
          {(
            [
              ["all", `すべて ${dossiers.length}`],
              ["article", `記事 ${articleCount}`],
              ["other", `その他 ${dossiers.length - articleCount}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`px-3 py-1 rounded-full text-sm transition-colors ${
                filter === key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center">
          <FolderSearch className="h-10 w-10 mx-auto text-slate-300 mb-2" />
          <p className="text-sm text-slate-500">
            {dossiers.length === 0 ? "まだドシエがありません。" : "条件に合うドシエはありません。"}
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((d) => {
          const isOwner = d.ownerId === currentUserId;
          return (
            <Link
              key={d.id}
              href={`/dossiers/${d.id}`}
              prefetch
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
                <p className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 mb-2">
                  <FileText className="h-3 w-3" />
                  記事{d.articleCount > 1 ? ` ${d.articleCount} 本` : ""}
                </p>
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
              <p className="mt-2 text-[10px] text-slate-400">更新 {formatDate(d.updatedAt)}</p>
            </Link>
          );
        })}
      </div>
    </>
  );
}
