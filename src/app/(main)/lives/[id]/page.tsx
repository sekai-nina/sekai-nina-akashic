import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getLive, listMaterialCandidates, livePeriodLabel } from "@/lib/domain/lives";
import { listSongKeys } from "@/lib/domain/songs";
import { listMeetGreetKeeps } from "@/lib/domain/meetgreet-reports";
import { listSketchSources } from "@/lib/domain/live-sketch";
import { getSketchSetting } from "@/lib/domain/sketch-setting";
import { jsonStringArray, MATERIAL_WINDOW_DAYS, REPORT_WINDOW_DAYS, TALK_SUGGEST_DAYS } from "@/lib/meetgreet/config";
import { cropsFromJson } from "@/lib/meetgreet/crop";
import { refsFromJson } from "@/lib/meetgreet/sketch-refs";
import { getR2PublicUrl } from "@/lib/r2";
import { formatDate } from "@/lib/utils";
import { MaterialsStep } from "@/components/materials-step";
import { ExcerptStep } from "@/components/workflow/excerpt-step";
import { ReportsStep } from "@/components/workflow/reports-step";
import { SketchStep } from "@/components/workflow/sketch-step";
import { ArticleStep } from "@/components/workflow/article-step";
import {
  applyExcerptsAction,
  applyMaterialsAction,
  generateSketchAction,
  proposeExcerptsAction,
  refetchReportsAction,
  saveExtraSketchPromptAction,
  saveSketchCropsAction,
  selectSketchAction,
  previewArticleAction,
  restoreExclusionsAction,
  saveArticleAction,
} from "../actions";
import { MetaForm } from "./meta-form";
import { ReportTagsForm } from "./report-tags-form";
import { SetlistForm } from "./setlist-form";

interface Props {
  params: Promise<{ id: string }>;
}

/** X レポの収集は最大 90 秒ほどかかる (画像を 1 枚ずつ R2 に載せるため) */
export const maxDuration = 300;

/**
 * ライブ 1 つ分の進行画面。公演 → 素材 → レポ → スケッチ → 記事 を縦に並べる。
 * ドシエ / /repo / 記事の中身はそれぞれの画面で扱い、ここからはリンクする。
 */
export default async function LiveDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) notFound();

  const live = await getLive(session.user, id);
  if (!live) notFound();

  const [candidates, songKeys, keeps, sketchSources, sketchSetting] = await Promise.all([
    listMaterialCandidates(session.user, live),
    listSongKeys(),
    listMeetGreetKeeps(session.user, live, live.reports?.keep ?? 0),
    listSketchSources(session.user, live),
    getSketchSetting(),
  ]);
  // 新しい候補を先に出す (作り直すほど古いものが上に溜まらないように)
  const sketchCandidates = jsonStringArray(live.sketchCandidates)
    .map((key) => ({ key, url: getR2PublicUrl(key) }))
    .reverse();
  const suggestedCount = candidates.reduce(
    (n, g) => n + g.assets.filter((a) => a.suggested).length,
    0
  );
  const itemCount = live.dossier?.itemCount ?? 0;

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/lives" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> ライブ一覧へ
      </Link>

      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">{live.name}</h1>
        <p className="text-xs text-slate-500 mt-1">
          {livePeriodLabel(live)} ·{" "}
          {live.performances.length} 公演 · 作成 {formatDate(live.createdAt)} · {live.createdBy.name}
        </p>
        <MetaForm id={live.id} name={live.name} note={live.note} entity={live.entity} />
      </div>

      {/* 1. 公演と披露曲 */}
      <StepCard
        no={1}
        title="公演と披露曲"
        done={live.performances.length > 0 && live.commonSongs.length > 0}
        summary={
          live.commonSongs.length > 0
            ? `共通披露曲 ${live.commonSongs.length} 曲`
            : "共通披露曲が未入力"
        }
      >
        <p className="text-xs text-slate-500 mb-3">
          記事の「公演」の表になります。全公演で披露した曲は共通披露曲に、その公演だけの曲は行の追加曲に入れてください。
          曲名は保存時に曲マスタ (<Link href="/songs" className="underline">曲</Link>) へ登録されます。マスタに無い曲は入力の下に出るので、誤字はその場で直してください。
        </p>
        <SetlistForm liveId={live.id} commonSongs={live.commonSongs} performances={live.performances} knownKeys={songKeys} />
      </StepCard>

      {/* 2. 素材 */}
      <StepCard
        no={2}
        title="素材"
        done={itemCount > 0}
        summary={live.dossier ? `ドシエに ${itemCount} 件` : "ドシエが見えません"}
        action={
          live.dossier ? (
            <Link href={`/dossiers/${live.dossierId}`} className={linkCls}>
              ドシエを開く <ExternalLink size={12} />
            </Link>
          ) : null
        }
      >
        {live.dossier ? (
          <>
            <p className="text-xs text-slate-500 mb-3">
              各公演日〜{MATERIAL_WINDOW_DAYS} 日後のブログ・トークと、イベントエンティティが付いたアセットから候補を出しています。
              本文にライブの話 (ライブ名・会場名を含む) があるブログと、公演日〜
              {TALK_SUGGEST_DAYS === 1 ? "翌日" : `${TALK_SUGGEST_DAYS} 日後`}
              のトーク画像 / 動画 ({suggestedCount} 件) は「おすすめ」としてまとめて入れられます。抜粋 (本人の感想) はドシエ側で範囲選択します。
            </p>
            <MaterialsStep
              groups={candidates}
              topic="ライブ"
              onApply={applyMaterialsAction.bind(null, live.id)}
            />
            <ExcerptStep
              kind="live"
              onPropose={proposeExcerptsAction.bind(null, live.id)}
              onApply={applyExcerptsAction.bind(null, live.id)}
            />
          </>
        ) : (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3">
            素材置き場のドシエが表示できません (所有者が非公開に戻したか、機密レベルが上がっています)。所有者にドシエの公開範囲を戻してもらってください。
          </p>
        )}
      </StepCard>

      {/* 3. レポ */}
      <StepCard
        no={3}
        title="X レポ"
        done={(live.reports?.keep ?? 0) > 0}
        summary={
          live.reports
            ? `採用 ${live.reports.keep} / 取得 ${live.reports.total}${live.repoCollection?.lastFetchedAt ? ` · 最終収集 ${formatDate(live.repoCollection.lastFetchedAt, true)}` : ""}`
            : "収集が紐づいていません"
        }
        action={
          live.repoCollection ? (
            <Link href={`/repo/${live.repoCollection.id}`} className={linkCls}>
              レポを判定する <ExternalLink size={12} />
            </Link>
          ) : null
        }
      >
        {live.repoCollection && <ReportTagsForm liveId={live.id} tags={jsonStringArray(live.reportTags)} />}
        <p className="text-xs text-slate-500 mb-3">
          期間は初日〜最終日{REPORT_WINDOW_DAYS === 1 ? "の翌日" : `+${REPORT_WINDOW_DAYS} 日`} (公演を直すと追随)。
          {live.repoCollection?.lastFetchedAt
            ? "公演のたびに再収集すると、その週の投稿を拾えます。"
            : "まだ収集していません。X の recent search は直近 7 日までなので、終わって日が経ったライブは取得できません。"}
          採用にしたツイートは記事生成がそのまま読みます。
        </p>
        <ReportsStep
          kind="live"
          onRefetch={refetchReportsAction.bind(null, live.id)}
          hasCollection={!!live.repoCollectionId}
          fetched={!!live.repoCollection?.lastFetchedAt}
          keeps={keeps}
        />
      </StepCard>

      {/* 4. スケッチ */}
      <StepCard
        no={4}
        title="衣装スケッチ"
        done={!!live.sketchKey}
        summary={
          live.sketchKey
            ? "確定済み"
            : sketchCandidates.length > 0
              ? `候補 ${sketchCandidates.length} 枚`
              : "未生成"
        }
        action={
          live.sketchKey ? (
            <a href={getR2PublicUrl(live.sketchKey)} target="_blank" rel="noreferrer" className={linkCls}>
              確定した画像を開く <ExternalLink size={12} />
            </a>
          ) : null
        }
      >
        <p className="text-xs text-slate-500 mb-3">
          ステージ衣装のスケッチ。衣装が複数あるときはメインに代表的な衣装、補助に他の衣装が描かれます (追加指示で指定できます)。
        </p>
        <SketchStep
          owner={{ kind: "live", id: live.id }}
          actions={{
            saveExtraPrompt: saveExtraSketchPromptAction.bind(null, live.id),
            generate: generateSketchAction.bind(null, live.id),
            saveCrops: saveSketchCropsAction.bind(null, live.id),
            select: selectSketchAction.bind(null, live.id),
          }}
          sources={sketchSources}
          candidates={sketchCandidates}
          selectedKey={live.sketchKey}
          extraPrompt={live.extraSketchPrompt}
          crops={cropsFromJson(live.sketchCrops)}
          refs={refsFromJson(live.sketchRefs).map((r) => ({ ...r, url: getR2PublicUrl(r.key) }))}
          styleReference={{
            url: sketchSetting.styleReferenceUrl,
            isDefault: sketchSetting.isDefaultStyleReference,
            canEdit: session.user.role === "admin",
          }}
        />
      </StepCard>

      {/* 5. 記事 */}
      <StepCard
        no={5}
        title="記事"
        done={!!live.article}
        summary={
          live.article
            ? `${live.article.title} (${live.article.dirty ? "未 push" : "push 済み"}${live.needsSync ? " · 要反映" : ""})`
            : "未生成"
        }
        action={
          live.article ? (
            <Link href={`/articles/${live.article.shortId}`} className={linkCls}>
              記事を開く <ExternalLink size={12} />
            </Link>
          ) : null
        }
      >
        <p className="text-xs text-slate-500 mb-3">
          公演の表 (<code>{"<!-- live:performances -->"}</code> の区間) は追記のたびに作り直され、公演や曲を直すと記事にも反映されます。
          本人の感想・ファンのレポ・関連メディアはミーグリと同じく「まだ無いものだけ」足します。
        </p>
        {live.needsSync && (
          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
            記事を書いた後にドシエが変わっています。差分を見て追記してください。
          </p>
        )}
        <ArticleStep
          hasArticle={!!live.article}
          hasDossier={!!live.dossier}
          onPreview={previewArticleAction.bind(null, live.id)}
          onSave={saveArticleAction.bind(null, live.id)}
          onRestore={restoreExclusionsAction.bind(null, live.id)}
        />
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
