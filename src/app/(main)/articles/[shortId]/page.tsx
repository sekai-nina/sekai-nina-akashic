import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { countArticlesLinkingTo, getArticleByShortId, getArticleTitleIndex } from "@/lib/domain/articles";
import { getDossierSummary } from "@/lib/domain/dossiers";
import {
  ARTICLE_FLAG_LABELS,
  ARTICLE_TYPE_LABELS,
  ARTICLE_SOURCE_STATUS_LABELS,
  ASSET_KIND_LABELS,
  formatDate,
} from "@/lib/utils";
import { frontmatterExtraKeys } from "@/lib/articles/edit";
import { auditFootnotes, footnoteRefsInBody } from "@/lib/articles/footnotes";
import { FootnoteAuditWarnings } from "./footnote-audit-warnings";
import { ApplySource } from "./apply-source";
import { RemoveSource } from "./remove-source";
import { UnpushedBadge } from "./unpushed-badge";
import { ArticleDossier } from "./article-dossier";
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
  searchParams,
}: {
  params: Promise<{ shortId: string }>;
  searchParams: Promise<{ renamedFrom?: string | string[]; applied?: string | string[] }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();

  const { shortId } = await params;
  // 編集でタイトルを変えた直後だけ付く。旧タイトルを [[ ]] で参照している記事を数えて警告する。
  // 同じキーが複数付くと配列で来るので、文字列のときだけ扱う
  const sp = await searchParams;
  const renamedFrom = typeof sp.renamedFrom === "string" ? sp.renamedFrom : undefined;
  // 「反映済みにする」の直後だけ付く。採番した脚注番号を本文に書くよう促す
  const appliedParam = typeof sp.applied === "string" && /^\d+$/.test(sp.applied) ? Number(sp.applied) : undefined;
  const [article, titleIndex, inboundLinks] = await Promise.all([
    getArticleByShortId(shortId, session.user.clearance),
    getArticleTitleIndex(),
    renamedFrom ? countArticlesLinkingTo(renamedFrom, shortId) : Promise.resolve(0),
  ]);
  if (!article) notFound();
  const canEdit = ["admin", "member"].includes(session.user.role);

  // 素材ドシエ (#41)。Dossier は所有者判定のある保護テーブルなので withSession で引き直す。
  // private にされていて見えなければ null (= 無いのと同じ表示にはせず、作るボタンも出さない)
  const dossierId = article.dossierId;
  const dossier = dossierId ? await getDossierSummary(session.user, dossierId) : null;

  const tags = Array.isArray(article.tags) ? (article.tags as unknown[]).map(String) : [];
  const extraKeys = frontmatterExtraKeys(article);
  const unresolvedCount = article.sources.filter((s) => s.status === "unresolved").length;
  const bodyHtml = await renderArticleBody(article.body, { wikilinks: titleIndex });
  const hasTweets = bodyHtml.includes('class="twitter-tweet"');

  // 本文の ^[n] と出典の対応。描画側でリンクにするのとは別に、対応の壊れを出す
  const sourceNumbers = article.sources.map((s) => s.sourceNo);
  const audit = auditFootnotes(article.body, sourceNumbers, new Set(titleIndex.keys()));
  // バナーは URL に残るので、実データで gate する (renamedFrom と同じ): その番号の出典が
  // まだあり、本文がまだ参照していないときだけ出す
  const applied =
    appliedParam != null &&
    sourceNumbers.includes(appliedParam) &&
    !footnoteRefsInBody(article.body).includes(appliedParam)
      ? appliedParam
      : undefined;

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
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
              {ARTICLE_FLAG_LABELS.draft}
            </span>
          )}
          {article.dirty && <UnpushedBadge editedAt={article.editedAt} />}
          {canEdit && (
            <Link
              href={`/articles/${article.shortId}/edit`}
              className="ml-auto border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50 transition-colors"
            >
              編集
            </Link>
          )}
        </div>
        <p className="text-slate-500 text-sm mt-1">
          {article.path} ・ short_id {article.shortId}
          {article.publishedAt && <> ・ 公開 {formatDate(article.publishedAt)}</>}
          {article.articleUpdatedAt && <> ・ 更新 {formatDate(article.articleUpdatedAt)}</>}
        </p>
        {renamedFrom && inboundLinks > 0 && (
          <div className="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {inboundLinks} 本の記事が旧タイトル [[{renamedFrom}]] でこの記事にリンクしています。
            そのままだと宛先を失うので、参照元の本文を書き換えてください（
            <Link href={`/articles?q=${encodeURIComponent(`[[${renamedFrom}`)}`} className="underline">
              参照元を検索
            </Link>
            ）
          </div>
        )}
        {applied != null && (
          <div className="mt-3 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            出典 [{applied}] を{ARTICLE_SOURCE_STATUS_LABELS.applied}にしました（次の push で公開されます）。本文の該当箇所に ^[{applied}] を書いてください（
            <Link href={`/articles/${article.shortId}/edit`} className="underline">
              編集
            </Link>
            ）
          </div>
        )}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {tags.map((t) => (
              <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                {t}
              </span>
            ))}
          </div>
        )}
        {(dossier || !dossierId) && (
          <div className="mt-3">
            <ArticleDossier
              articleId={article.id}
              shortId={article.shortId}
              dossier={dossier ? { id: dossier.id, title: dossier.title, itemCount: dossier._count.items } : null}
              canEdit={canEdit}
            />
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
            <div
              key={s.id}
              id={s.sourceNo != null ? `src-${s.sourceNo}` : undefined}
              className="px-4 py-3 target:bg-amber-50 scroll-mt-4"
            >
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
                {/* 解除・反映できるのは akashic 側で付けた未反映の紐づけだけ。
                    取り込み由来の applied を消すと記事の出典が壊れる。
                    反映は公開を決める操作なので、確認を挟む (ApplySource) */}
                {canEdit && s.status === "pending" && (
                  <>
                    <ApplySource id={s.id} shortId={article.shortId} updatedAt={article.updatedAt.toISOString()} />
                    <RemoveSource id={s.id} shortId={article.shortId} />
                  </>
                )}
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
        <FootnoteAuditWarnings audit={audit} className="mb-2" />
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
