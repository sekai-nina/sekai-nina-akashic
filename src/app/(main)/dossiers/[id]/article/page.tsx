import Link from "next/link";
import { ArrowLeft, ExternalLink, FileText } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDossierKind } from "@/lib/domain/dossiers";
import { getDossierArticleWorkflow } from "@/lib/domain/dossier-article-workflow";
import { WorkflowInputError } from "@/lib/domain/article-workflow";
import { suggestTemplate } from "@/lib/domain/dossier-article";
import { getTemplate, selectableTemplates } from "@/lib/article-workflow/templates";
import { ARTICLE_TEMPLATE_LABELS, ARTICLE_WORKFLOW_LABELS as L, cn } from "@/lib/utils";
import { ArticleStep } from "@/components/workflow/article-step";
import { previewDossierArticleAction, restoreDossierExclusionsAction, saveDossierArticleAction } from "./actions";
import { TemplatePicker } from "./template-picker";
import { PendingClips } from "./pending-clips";
import { AiMergeStep } from "./ai-merge-step";
import { listPendingDossiers } from "@/lib/domain/dossier-sync-queue";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ article?: string }>;
}

/** 外部の短縮URLの解決・AIの下書き生成を含む。 */
export const maxDuration = 300;

/** 一般ドシエ・ミーグリ・ライブが共通で使う記事生成の画面 (#233 段階2)。 */
export default async function DossierArticlePage({ params, searchParams }: Props) {
  const { id } = await params;
  const { article: chosen } = await searchParams;
  const session = await auth();
  if (!session?.user) notFound();
  if (await getDossierKind(session.user, id) === "clips") redirect("/clips");

  const workflow = await getDossierArticleWorkflow(session.user, id, chosen ?? null).catch((error: unknown) => {
    if (error instanceof WorkflowInputError) return { error: error.message };
    throw error;
  });
  if (!workflow) notFound();
  if ("error" in workflow) {
    return <div className="max-w-4xl mx-auto px-4 py-6">
      <Link href={`/dossiers/${id}`} className="text-xs text-indigo-700 hover:underline">{L.backToDossier}</Link>
      <h1 className="mt-3 text-lg font-semibold">{L.makeArticle}</h1>
      <p role="alert" className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{workflow.error}</p>
    </div>;
  }
  const { dossier, preparation, template: current, article: target, articleId, needsChoice, editable } = workflow;
  const queue = await listPendingDossiers(session.user);
  const unreflected = queue.find((p) => p.dossierId === dossier.id)?.clips ?? [];
  // 本文を AI / 人が書くテンプレートの追記は、新しい素材を AI に組み込ませられる (#275)
  // 反映待ちが無くても出しておく (保存して反映待ちが消えた直後に、結果の表示ごと消えないように)
  const canAiMerge = !preparation && editable && !needsChoice && !!target && !!current && !!getTemplate(current)?.needsAi;
  // 反映待ちを 1 本ずつ進める。並びは一覧の「反映待ち」タブと同じ (新しい順) で、いまの企画の次。
  // いまの企画が片付いて列から消えていたら先頭へ
  const here = queue.findIndex((p) => p.dossierId === dossier.id);
  const others = queue.filter((p) => p.dossierId !== dossier.id);
  const nextPending = others[here === -1 ? 0 : here] ?? others[0] ?? null;
  const templates = selectableTemplates().map((t) => ({ key: t.key, label: ARTICLE_TEMPLATE_LABELS[t.key] }));
  const supported = !!preparation || templates.some((t) => t.key === current);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <Link href={`/dossiers/${dossier.id}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> {L.backToDossier}
      </Link>
      <h1 className="mt-2 text-lg font-semibold text-slate-900 flex items-center gap-2"><FileText className="h-4 w-4 text-indigo-600" />{L.makeArticle}</h1>
      <p className="text-xs text-slate-500 mt-1">{dossier.title}</p>

      {preparation && <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-sm font-semibold text-slate-700">{ARTICLE_TEMPLATE_LABELS[preparation.kind]} · {L.preparation}</h2>
            <p className="mt-1 text-xs text-slate-500">{preparation.title} · {preparation.period}</p></div>
          <Link href={preparation.href} className="text-xs text-indigo-700 hover:underline">{L.backToPreparation} →</Link>
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">
          <div><dt className="inline text-slate-500">{L.materials} </dt><dd className="inline">{preparation.materialCount}</dd></div>
          <div><dt className="inline text-slate-500">{L.reports} </dt><dd className="inline">{preparation.keptReports}</dd></div>
          <div><dt className="inline text-slate-500">{L.sketch} </dt><dd className="inline">{preparation.hasSketch ? L.ready : L.unset}</dd></div>
        </dl>
        <p className="mt-2 text-xs text-slate-500">{L.prepareHelp}</p>
      </section>}

      <section className="mt-4 bg-white border border-slate-200 rounded-lg p-4">
        <h2 className="text-xs font-semibold text-slate-500 mb-3">{L.template}</h2>
        {preparation ? <><p className="text-sm font-medium">{ARTICLE_TEMPLATE_LABELS[preparation.kind]}</p><p className="mt-1 text-xs text-slate-500">{L.fixedTemplate}</p></> : <TemplatePicker
          dossierId={dossier.id} current={current} suggested={suggestTemplate(dossier)} options={templates}
          locked={!!current && dossier.articles.length > 0} editable={editable}
        />}
        {current && !supported && <p className="mt-2 text-xs text-amber-800">{L.unsupportedTemplate}</p>}
      </section>

      <section className="mt-4 bg-white border border-slate-200 rounded-lg p-4">
        <h2 className="text-xs font-semibold text-slate-500 mb-3">{L.article}</h2>
        {preparation?.needsSync && <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">{L.needsSync}</p>}
        {preparation?.kind === "live" && <p className="mb-3 text-xs text-slate-500">{L.liveAppendHelp}</p>}
        {!preparation && dossier.articles.length > 1 && <div className="mb-3">
          <p className="mb-2 text-xs text-slate-500">{L.chooseArticle}</p>
          <ul className="flex flex-wrap gap-2">{dossier.articles.map((a) => <li key={a.id}>
            <Link href={`/dossiers/${dossier.id}/article?article=${a.id}`} className={cn("inline-flex rounded-md border px-3 py-1.5 text-xs", a.id === articleId ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 text-slate-700 hover:bg-slate-50")}>{a.title || a.shortId}</Link>
          </li>)}</ul>
        </div>}
        {!editable ? <p className="text-xs text-slate-500">{L.readOnly}</p>
          : !current ? <p className="text-xs text-slate-500">{L.chooseTemplate}</p>
            : needsChoice ? <p className="text-xs text-slate-500">{L.chooseTarget}</p>
              : supported && <>
                {canAiMerge && <div className="mb-4 border-b border-slate-100 pb-4">
                  <h3 className="mb-2 text-xs font-semibold text-slate-600">{L.aiMerge}</h3>
                  <AiMergeStep key={JSON.stringify([dossier.id, articleId])} dossierId={dossier.id} articleId={articleId} />
                  <p className="mt-3 text-[11px] text-slate-500">{L.sourcesOnly}</p>
                </div>}
                <ArticleStep key={JSON.stringify([dossier.id, current, articleId])} hasArticle={!!target} hasDossier
                onPreview={previewDossierArticleAction.bind(null, dossier.id, articleId)}
                onSave={saveDossierArticleAction.bind(null, dossier.id, articleId)}
                onRestore={restoreDossierExclusionsAction.bind(null, dossier.id, articleId)}
              />
              </>}
      </section>

      {unreflected.length > 0 && <section className="mt-4 rounded-lg border border-amber-200 bg-white p-4">
        <h2 className="text-xs font-semibold text-slate-500 mb-2">{L.pendingClips(unreflected.length)}</h2>
        <PendingClips clips={unreflected} />
      </section>}

      {target && <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-xs font-semibold text-slate-500">{L.next}</h2>
        <p className="mt-2 text-sm text-slate-700">{target.title || target.shortId}{target.draft ? ` · ${L.draft}` : ""}</p>
        <p className="mt-1 text-xs text-slate-500">{L.afterSave} {L.saveDoesNotPublish}</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link href={`/articles/${target.shortId}${editable ? "/edit" : ""}`} className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-2 text-xs text-white">{editable ? L.editArticle : L.viewArticle}<ExternalLink size={12} /></Link>
          {current === "quote_blog" && editable && <Link href={`/quotes/${target.shortId}`} className="rounded-md bg-emerald-600 px-3 py-2 text-xs text-white">{L.selectQuote}</Link>}
          {session.user.role === "admin" && <Link href="/articles/push" className="rounded-md border border-slate-200 px-3 py-2 text-xs text-slate-700">{L.publish}</Link>}
        </div>
      </section>}

      {(here !== -1 || nextPending) && <section className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <p className="text-xs text-slate-500">{L.pendingQueue(queue.length)}{nextPending ? "" : ` · ${L.noMorePending}`}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/dossiers?filter=pending" className="text-xs text-slate-600 hover:underline">{L.backToPendingList}</Link>
          {nextPending && <Link href={`/dossiers/${nextPending.dossierId}/article`} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-2 text-xs text-white hover:bg-indigo-700">
            {L.nextPending}{nextPending.title ? `: ${nextPending.title}` : ""} →
          </Link>}
        </div>
      </section>}
    </div>
  );
}
