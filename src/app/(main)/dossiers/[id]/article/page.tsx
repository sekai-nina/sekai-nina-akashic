import Link from "next/link";
import { ArrowLeft, ExternalLink, FileText } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDossierForArticle, suggestTemplate } from "@/lib/domain/dossier-article";
import { selectableTemplates } from "@/lib/article-workflow/templates";
import { ARTICLE_TEMPLATE_LABELS, ARTICLE_TYPE_LABELS } from "@/lib/utils";
import { ArticleStep } from "@/components/article-step";
import {
  previewDossierArticleAction,
  restoreDossierExclusionsAction,
  saveDossierArticleAction,
} from "./actions";
import { TemplatePicker } from "./template-picker";

interface Props {
  params: Promise<{ id: string }>;
  /** `?article=<id>` は追記先 (ドシエに記事が 2 本以上あるとき) */
  searchParams: Promise<{ article?: string }>;
}

/** TikTok の短縮 URL の解決で外部に出るので、少し余裕を持たせる */
export const maxDuration = 120;

/**
 * 器 (MeetGreet / Live) を持たないドシエから記事を作る (#170)。
 * テンプレートを決める → 差分を見る → 保存、の 1 画面。ミーグリのステップ 4 と同じ部品を使う。
 */
export default async function DossierArticlePage({ params, searchParams }: Props) {
  const { id } = await params;
  const { article: chosen } = await searchParams;
  const session = await auth();
  if (!session?.user) notFound();

  const dossier = await getDossierForArticle(session.user, id);
  if (!dossier) notFound();
  if (dossier.kind === "clips") redirect("/clips");

  const templates = selectableTemplates().map((t) => ({
    key: t.key,
    label: ARTICLE_TEMPLATE_LABELS[t.key],
  }));
  const current = dossier.articleTemplate;
  const currentSelectable = current ? templates.some((t) => t.key === current) : false;
  const articleId =
    chosen && dossier.articles.some((a) => a.id === chosen)
      ? chosen
      : dossier.articles.length === 1
        ? dossier.articles[0].id
        : null;
  const target = dossier.articles.find((a) => a.id === articleId) ?? null;
  const needsChoice = dossier.articles.length > 1 && !articleId;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <Link
        href={`/dossiers/${dossier.id}`}
        className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
      >
        <ArrowLeft size={14} /> ドシエへ
      </Link>

      <h1 className="mt-2 text-lg font-semibold text-slate-900 flex items-center gap-2">
        <FileText className="h-4 w-4 text-indigo-600" />
        記事にする
      </h1>
      <p className="text-xs text-slate-500 mt-1">{dossier.title}</p>

      {dossier.container ? (
        <p className="mt-6 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          このドシエは{dossier.container === "meetgreet" ? "ミーグリ" : "ライブ"}
          の素材です。記事は{" "}
          <Link
            href={dossier.container === "meetgreet" ? "/meetgreets" : "/lives"}
            className="underline underline-offset-2"
          >
            {dossier.container === "meetgreet" ? "/meetgreets" : "/lives"}
          </Link>{" "}
          の進行画面から作ってください。
        </p>
      ) : (
        <>
          <section className="mt-6 bg-white border border-slate-200 rounded-lg p-4">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">1. テンプレート</h2>
            <TemplatePicker
              dossierId={dossier.id}
              current={current}
              suggested={suggestTemplate(dossier)}
              options={templates}
              locked={!!current && dossier.articles.length > 0}
            />
            {current && !currentSelectable && (
              <p className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                このドシエのテンプレート「{ARTICLE_TEMPLATE_LABELS[current]}」はまだ記事の組み立てに対応していません。
              </p>
            )}
          </section>

          <section className="mt-4 bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">2. 記事</h2>
              {target && (
                <Link
                  href={`/articles/${target.shortId}`}
                  className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 underline underline-offset-2"
                >
                  {target.title || target.shortId}
                  {target.draft ? "（下書き）" : ""} を開く <ExternalLink size={12} />
                </Link>
              )}
            </div>

            {dossier.articles.length > 1 && (
              <div className="mb-3">
                <p className="text-[11px] text-slate-500 mb-1.5">
                  このドシエからの記事が {dossier.articles.length} 本あります。追記する記事を選んでください。
                </p>
                <ul className="flex flex-wrap gap-2">
                  {dossier.articles.map((a) => (
                    <li key={a.id}>
                      <Link
                        href={`/dossiers/${dossier.id}/article?article=${a.id}`}
                        className={
                          "inline-flex items-center h-7 px-2.5 rounded-md border text-xs " +
                          (a.id === articleId
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 text-slate-700 hover:bg-slate-50")
                        }
                      >
                        {a.title || a.shortId}
                        {a.type ? ` · ${ARTICLE_TYPE_LABELS[a.type]}` : ""}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!current ? (
              <p className="text-xs text-slate-400">先にテンプレートを決めてください。</p>
            ) : needsChoice ? (
              <p className="text-xs text-slate-400">追記する記事を選ぶと差分を出せます。</p>
            ) : (
              <ArticleStep
                hasArticle={!!target}
                hasDossier
                onPreview={previewDossierArticleAction.bind(null, dossier.id, articleId)}
                onSave={saveDossierArticleAction.bind(null, dossier.id, articleId)}
                onRestore={restoreDossierExclusionsAction.bind(null, dossier.id, articleId)}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
