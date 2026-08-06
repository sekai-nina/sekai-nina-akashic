import Link from "next/link";
import { notFound } from "next/navigation";
import type { ArticleType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { listArticles, getArticleStats, ARTICLE_PAGE_SIZE } from "@/lib/domain/articles";
import { ARTICLE_TYPE_LABELS, formatDate } from "@/lib/utils";

const TYPES = ["attribute", "event", "quote", "column", "item", "quiz"] as const;

export default async function ArticlesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; type?: string; q?: string; unresolved?: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();

  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1"));
  const type = TYPES.includes(params.type as (typeof TYPES)[number])
    ? (params.type as ArticleType)
    : undefined;
  const q = params.q ?? "";
  const onlyUnresolved = params.unresolved === "1";

  // Article は非保護だが ArticleSource は保護テーブル。ドメイン層が
  // withClearance でまとめて読む。
  const [{ items, total }, stats] = await Promise.all([
    listArticles({
      clearance: session.user.clearance,
      page,
      type,
      q,
      onlyUnresolved,
    }),
    getArticleStats(session.user.clearance),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / ARTICLE_PAGE_SIZE));
  const qs = (over: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    const merged = { type: params.type, q: q || undefined, unresolved: params.unresolved, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, v);
    const s = sp.toString();
    return s ? `/articles?${s}` : "/articles";
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">記事</h1>
        <p className="text-slate-500 text-sm mt-1">
          世界新奈の記事 {stats.total} 本 — 表示中 {total} 件
          {stats.unresolved > 0 && (
            <>
              {" / "}
              <Link href={qs({ unresolved: "1", page: undefined })} className="text-amber-700 hover:underline">
                未解決の出典 {stats.unresolved} 件
              </Link>
            </>
          )}
          {stats.dirty > 0 && <> {" / "}未 push {stats.dirty} 本</>}
        </p>
      </div>

      {/* 検索 */}
      <form action="/articles" className="mb-4 flex gap-2">
        {params.type && <input type="hidden" name="type" value={params.type} />}
        {onlyUnresolved && <input type="hidden" name="unresolved" value="1" />}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="タイトル・本文を検索"
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
        />
        <button
          type="submit"
          className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm hover:bg-slate-700"
        >
          検索
        </button>
      </form>

      {/* 種別フィルタ */}
      <div className="flex flex-wrap gap-2 mb-4">
        <Link
          href={qs({ type: undefined, page: undefined })}
          className={`px-3 py-1 rounded-full text-sm ${
            !type ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          すべて
        </Link>
        {TYPES.map((t) => {
          const n = stats.byType.find((b) => b.type === t)?._count ?? 0;
          if (n === 0) return null;
          return (
            <Link
              key={t}
              href={qs({ type: t, page: undefined })}
              className={`px-3 py-1 rounded-full text-sm ${
                type === t ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {ARTICLE_TYPE_LABELS[t]} {n}
            </Link>
          );
        })}
        {onlyUnresolved && (
          <Link
            href={qs({ unresolved: undefined, page: undefined })}
            className="px-3 py-1 rounded-full text-sm bg-amber-100 text-amber-800 hover:bg-amber-200"
          >
            未解決のみ ✕
          </Link>
        )}
      </div>

      {/* 一覧 */}
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {items.length === 0 && (
          <p className="px-4 py-8 text-center text-slate-400 text-sm">該当する記事がありません</p>
        )}
        {items.map((a) => (
          <Link
            key={a.id}
            href={`/articles/${a.shortId}`}
            className="block px-4 py-3 hover:bg-slate-50"
          >
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-medium text-slate-900">{a.title}</span>
              {a.type && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                  {ARTICLE_TYPE_LABELS[a.type]}
                </span>
              )}
              {a.draft && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">下書き</span>
              )}
              {a.unlisted && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">限定公開</span>
              )}
              {a.dirty && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">未 push</span>
              )}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {a.publishedAt ? formatDate(a.publishedAt) : "日付なし"} ・ 出典 {a._count.sources} 件 ・{" "}
              {a.path}
            </div>
          </Link>
        ))}
      </div>

      {/* ページャ */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-6">
          {page > 1 && (
            <Link
              href={qs({ page: String(page - 1) })}
              className="px-3 py-1 rounded border border-slate-200 text-sm hover:bg-slate-50"
            >
              前へ
            </Link>
          )}
          <span className="px-3 py-1 text-sm text-slate-500">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <Link
              href={qs({ page: String(page + 1) })}
              className="px-3 py-1 rounded border border-slate-200 text-sm hover:bg-slate-50"
            >
              次へ
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
