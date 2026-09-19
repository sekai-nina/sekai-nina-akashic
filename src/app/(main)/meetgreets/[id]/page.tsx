import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getMeetGreet, listMaterialCandidates, meetGreetTitle } from "@/lib/domain/meetgreets";
import { listMeetGreetKeeps } from "@/lib/domain/meetgreet-reports";
import { getSketchSetting } from "@/lib/domain/sketch-setting";
import { listSketchSources } from "@/lib/domain/meetgreet-sketch";
import { jsonStringArray } from "@/lib/meetgreet/config";
import { cropsFromJson } from "@/lib/meetgreet/crop";
import { getR2PublicUrl } from "@/lib/r2";
import { MATERIAL_WINDOW_DAYS, REPORT_WINDOW_DAYS, TALK_SUGGEST_DAYS } from "@/lib/meetgreet/config";
import { formatDate } from "@/lib/utils";
import { MetaForm } from "./meta-form";
import { MaterialsStep } from "./materials-step";
import { ExcerptStep } from "./excerpt-step";
import { ReportsStep } from "./reports-step";
import { ArticleStep } from "./article-step";
import { SketchStep } from "./sketch-step";

interface Props {
  params: Promise<{ id: string }>;
}

/** X レポの収集は最大 90 秒ほどかかる (画像を 1 枚ずつ R2 に載せるため) */
export const maxDuration = 300;

/**
 * ミーグリ 1 回分の進行画面。素材 → レポ → スケッチ → 記事 を縦に並べる。
 * ドシエ / /repo / 記事の中身はそれぞれの画面で扱い、ここからはリンクする。
 */
export default async function MeetGreetDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) notFound();

  const mg = await getMeetGreet(session.user, id);
  if (!mg) notFound();

  const [candidates, sketchSources, keeps, sketchSetting] = await Promise.all([
    listMaterialCandidates(session.user, mg),
    listSketchSources(session.user, mg),
    listMeetGreetKeeps(session.user, mg, mg.reports?.keep ?? 0),
    getSketchSetting(),
  ]);
  // 新しい候補を先に出す (作り直すほど古いものが上に溜まらないように)
  const sketchCandidates = jsonStringArray(mg.sketchCandidates)
    .map((key) => ({ key, url: getR2PublicUrl(key) }))
    .reverse();
  const suggestedCount = candidates.reduce(
    (n, g) => n + g.assets.filter((a) => a.suggested).length,
    0
  );
  const itemCount = mg.dossier?.itemCount ?? 0;

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/meetgreets" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> ミーグリ一覧へ
      </Link>

      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">{meetGreetTitle(mg)}</h1>
        <p className="text-xs text-slate-500 mt-1">
          作成 {formatDate(mg.createdAt)} · {mg.createdBy.name}
        </p>
        <MetaForm
          id={mg.id}
          single={mg.single}
          label={mg.label}
          venue={mg.venue}
          isReal={mg.format === "real"}
        />
      </div>

      {/* 1. 素材 */}
      <StepCard
        no={1}
        title="素材"
        done={itemCount > 0}
        summary={mg.dossier ? `ドシエに ${itemCount} 件` : "ドシエが見えません"}
        action={
          mg.dossier ? (
            <Link href={`/dossiers/${mg.dossierId}`} className={linkCls}>
              ドシエを開く <ExternalLink size={12} />
            </Link>
          ) : null
        }
      >
        {mg.dossier ? (
          <>
            <p className="text-xs text-slate-500 mb-3">
              当日〜{MATERIAL_WINDOW_DAYS} 日後のブログ・トークから候補を出しています。本文にミーグリの話があるブログと、当日〜
              {TALK_SUGGEST_DAYS === 1 ? "翌日" : `${TALK_SUGGEST_DAYS} 日後`}
              のトーク画像 / 動画は最初からチェック済み ({suggestedCount} 件)。外す / 足すだけして「ドシエに反映」を押してください。抜粋 (本人の感想) はドシエ側で範囲選択します。
            </p>
            <MaterialsStep meetGreetId={mg.id} groups={candidates} />
            <ExcerptStep meetGreetId={mg.id} />
          </>
        ) : (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3">
            素材置き場のドシエが表示できません (所有者が非公開に戻したか、機密レベルが上がっています)。所有者にドシエの公開範囲を戻してもらってください。
          </p>
        )}
      </StepCard>

      {/* 2. レポ */}
      <StepCard
        no={2}
        title="X レポ"
        done={(mg.reports?.keep ?? 0) > 0}
        summary={
          mg.reports
            ? `採用 ${mg.reports.keep} / 取得 ${mg.reports.total}${mg.repoCollection?.lastFetchedAt ? ` · 最終収集 ${formatDate(mg.repoCollection.lastFetchedAt, true)}` : ""}`
            : "収集が紐づいていません"
        }
        action={
          mg.repoCollection ? (
            <Link href={`/repo/${mg.repoCollection.id}`} className={linkCls}>
              レポを判定する <ExternalLink size={12} />
            </Link>
          ) : null
        }
      >
        <p className="text-xs text-slate-500 mb-3">
          {mg.repoCollection?.lastFetchedAt
            ? `${REPORT_WINDOW_DAYS === 1 ? "翌日" : `${REPORT_WINDOW_DAYS} 日後`}以降の投稿を拾うときは再収集してください。`
            : "まだ収集していません。X の recent search は直近 7 日までなので、開催から日が経っている回は取得できません。"}
          採用にしたツイートは記事生成がそのまま読みます。
        </p>
        <ReportsStep
          meetGreetId={mg.id}
          hasCollection={!!mg.repoCollectionId}
          fetched={!!mg.repoCollection?.lastFetchedAt}
          keeps={keeps}
        />
      </StepCard>

      {/* 3. スケッチ */}
      <StepCard
        no={3}
        title="スケッチ"
        done={!!mg.sketchKey}
        summary={
          mg.sketchKey
            ? "確定済み"
            : sketchCandidates.length > 0
              ? `候補 ${sketchCandidates.length} 枚`
              : "未生成"
        }
        action={
          mg.sketchKey ? (
            <a href={getR2PublicUrl(mg.sketchKey)} target="_blank" rel="noreferrer" className={linkCls}>
              確定した画像を開く <ExternalLink size={12} />
            </a>
          ) : null
        }
      >
        <SketchStep
          meetGreetId={mg.id}
          sources={sketchSources}
          candidates={sketchCandidates}
          selectedKey={mg.sketchKey}
          extraPrompt={mg.extraSketchPrompt}
          crops={cropsFromJson(mg.sketchCrops)}
          styleReference={{
            url: sketchSetting.styleReferenceUrl,
            isDefault: sketchSetting.isDefaultStyleReference,
            canEdit: session.user.role === "admin",
          }}
        />
      </StepCard>

      {/* 4. 記事 */}
      <StepCard
        no={4}
        title="記事"
        done={!!mg.article}
        summary={
          mg.article
            ? `${mg.article.title} (${mg.article.dirty ? "未 push" : "push 済み"}${mg.needsSync ? " · 要反映" : ""})`
            : "未生成"
        }
        action={
          mg.article ? (
            <Link href={`/articles/${mg.article.shortId}`} className={linkCls}>
              記事を開く <ExternalLink size={12} />
            </Link>
          ) : null
        }
      >
        {mg.needsSync && (
          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
            記事を書いた後にドシエが変わっています。差分を見て追記してください。
          </p>
        )}
        <ArticleStep meetGreetId={mg.id} hasArticle={!!mg.article} hasDossier={!!mg.dossier} />
      </StepCard>
    </div>
  );
}

const linkCls =
  "inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 underline underline-offset-2 shrink-0 whitespace-nowrap";

function StepCard({
  no,
  title,
  done,
  summary,
  action,
  children,
}: {
  no: number;
  title: string;
  done: boolean;
  summary: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-lg p-5 mb-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={
              "inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold shrink-0 " +
              (done ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-600")
            }
          >
            {no}
          </span>
          <h2 className="text-sm font-semibold text-slate-900 shrink-0">{title}</h2>
          <span className="text-xs text-slate-500 truncate">{summary}</span>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
