import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getArticleByShortId, getWikilinkMap } from "@/lib/domain/articles";
import {
  ARTICLE_TYPE_LABELS,
  ARTICLE_SOURCE_STATUS_LABELS,
  ASSET_KIND_LABELS,
  formatDate,
} from "@/lib/utils";
import { RemoveSource } from "./remove-source";
import { renderArticleBody } from "@/lib/articles/render";
import "../article-content.css";
import "katex/dist/katex.min.css";

const STATUS_STYLE: Record<string, string> = {
  applied: "bg-emerald-100 text-emerald-700",
  pending: "bg-blue-100 text-blue-700",
  unresolved: "bg-amber-100 text-amber-800",
};

export default async function ArticleDetailPage({
  params,
}: {
  params: Promise<{ shortId: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();

  const { shortId } = await params;
  const article = await getArticleByShortId(shortId, session.user.clearance);
  if (!article) notFound();

  const tags = Array.isArray(article.tags) ? (article.tags as unknown[]).map(String) : [];
  const extraKeys = Object.keys((article.frontmatterExtra ?? {}) as object);
  const unresolvedCount = article.sources.filter((s) => s.status === "unresolved").length;
  const wikilinks = await getWikilinkMap();
  const bodyHtml = await renderArticleBody(article.body, { wikilinks });
  const hasTweets = bodyHtml.includes('class="twitter-tweet"');

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/articles" className="text-sm text-slate-500 hover:underline">
        ← 記事一覧
      </Link>

      <div className="mt-3 mb-6">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h1 className="text-2xl font-bold text-slate-900">{article.title}</h1>
          {article.type && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
              {ARTICLE_TYPE_LABELS[article.type]}
            </span>
          )}
          {article.draft && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">下書き</span>
          )}
          {article.dirty && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">未 push</span>
          )}
        </div>
        <p className="text-slate-500 text-sm mt-1">
          {article.path} ・ short_id {article.shortId}
          {article.publishedAt && <> ・ 公開 {formatDate(article.publishedAt)}</>}
          {article.articleUpdatedAt && <> ・ 更新 {formatDate(article.articleUpdatedAt)}</>}
        </p>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {tags.map((t) => (
              <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 出典 */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-2">
          出典 {article.sources.length} 件
          {unresolvedCount > 0 && (
            <span className="ml-2 text-amber-700 font-normal">未解決 {unresolvedCount} 件</span>
          )}
        </h2>
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {article.sources.length === 0 && (
            <p className="px-4 py-6 text-center text-slate-400 text-sm">出典なし</p>
          )}
          {article.sources.map((s) => (
            <div key={s.id} id={s.sourceNo != null ? `source-${s.sourceNo}` : undefined} className="px-4 py-3 scroll-mt-4">
              <div className="flex items-baseline gap-2 flex-wrap">
                {s.sourceNo != null && (
                  <span className="text-xs text-slate-400 font-mono">[{s.sourceNo}]</span>
                )}
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${STATUS_STYLE[s.status] ?? "bg-slate-100 text-slate-600"}`}
                >
                  {ARTICLE_SOURCE_STATUS_LABELS[s.status]}
                </span>
                {s.asset ? (
                  <Link
                    href={`/assets/${s.asset.id}`}
                    className="text-sm text-slate-900 hover:underline"
                  >
                    {s.asset.title || s.label || "(無題)"}
                  </Link>
                ) : (
                  <span className="text-sm text-slate-700">{s.label || "(ラベルなし)"}</span>
                )}
                {s.asset && (
                  <span className="text-xs text-slate-400">
                    {ASSET_KIND_LABELS[s.asset.kind] ?? s.asset.kind}
                  </span>
                )}
                {/* 解除できるのは akashic 側で付けた未反映の紐づけだけ。
                    取り込み由来の applied を消すと記事の出典が壊れる。 */}
                {s.status === "pending" && <RemoveSource id={s.id} shortId={article.shortId} />}
              </div>

              {s.excerpt && (
                <blockquote className="mt-2 pl-3 border-l-2 border-slate-200 text-sm text-slate-600">
                  {s.excerpt}
                </blockquote>
              )}

              <div className="text-xs text-slate-400 mt-1 space-x-2">
                {s.date && <span>{formatDate(s.date)}</span>}
                {s.url && (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline break-all"
                  >
                    {s.url}
                  </a>
                )}
                {s.status === "unresolved" && s.originalRef && (
                  <span className="text-amber-700">元 ref: {s.originalRef}（Asset 不在）</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 本文 — sekai-nina-site と同じ remark/rehype パイプラインで HTML 化する。
          プラグインが生 HTML ノードを吐くので dangerouslySetInnerHTML で出す。
          中身は自リポジトリの記事 Markdown なので入力は信頼できる。 */}
      <section>
        <h2 className="text-sm font-semibold text-slate-700 mb-2">本文</h2>
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="article-content" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        </div>
        {/* X の埋め込みは remarkTweets が blockquote.twitter-tweet を出しておき、
            widgets.js がそれを見つけて描画する。クライアント部品を挟まないのは、
            dangerouslySetInnerHTML の div がハイドレーション対象にならず
            useEffect が走らなかったため。 */}
        {hasTweets && (
          <script async src="https://platform.twitter.com/widgets.js" charSet="utf-8" />
        )}
      </section>

      {extraKeys.length > 0 && (
        <p className="text-xs text-slate-400 mt-4">
          モデル外の frontmatter: {extraKeys.join(", ")}（push 時に復元されます）
        </p>
      )}
    </div>
  );
}
