import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getArticleByShortId, listArticleTags } from "@/lib/domain/articles";
import { frontmatterExtraKeys, toArticleEditFormValues, toArticleEditValues } from "@/lib/articles/edit";
import { UnpushedBadge } from "../unpushed-badge";
import { ArticleEditor } from "./article-editor";
import "../../article-content.css";
import "katex/dist/katex.min.css";

/**
 * 記事の編集。本文 (Markdown) と、モデル化済みの frontmatter (title / type / tags /
 * 日付系 / draft / unlisted / ongoing) を直せる。保存で `dirty` が立ち、`/articles/push`
 * から GitHub に書き出す (保存ごとに commit はしない)。
 *
 * `frontmatterExtra` (featured_quotes / locations / dossier 等) と出典 (ArticleSource) は
 * ここでは触らせない。前者は push 時にそのまま復元され、後者は pending → applied の遷移と
 * 一緒に別の画面 (PR3) で扱う。
 *
 * 書き込みは admin / member。viewer は詳細へ返す (push 画面と同じ流儀)。
 */
export default async function ArticleEditPage({
  params,
}: {
  params: Promise<{ shortId: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();
  const { shortId } = await params;
  if (!["admin", "member"].includes(session.user.role)) redirect(`/articles/${shortId}`);

  const [article, tagOptions] = await Promise.all([
    getArticleByShortId(shortId, session.user.clearance),
    listArticleTags(),
  ]);
  if (!article) notFound();

  const extraKeys = frontmatterExtraKeys(article);

  return (
    <div className="max-w-6xl mx-auto">
      <Link href={`/articles/${shortId}`} className="text-sm text-slate-500 hover:underline">
        ← {article.title || "(無題)"}
      </Link>
      <div className="mt-3 mb-6">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h1 className="text-2xl font-bold text-slate-900">記事を編集</h1>
          {article.dirty && <UnpushedBadge editedAt={article.editedAt} />}
        </div>
        <p className="text-slate-500 text-sm mt-1">
          <span className="font-mono">{article.path}</span> ・ short_id {article.shortId}
        </p>
      </div>

      <ArticleEditor
        shortId={article.shortId}
        updatedAt={article.updatedAt.toISOString()}
        initial={toArticleEditFormValues(toArticleEditValues(article))}
        tagOptions={tagOptions}
        extraKeys={extraKeys}
        sources={article.sources.map((s) => ({
          id: s.id,
          sourceNo: s.sourceNo,
          status: s.status,
          label: s.asset?.title || s.label,
        }))}
      />
    </div>
  );
}
