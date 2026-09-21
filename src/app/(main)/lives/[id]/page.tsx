import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getLive, listMaterialCandidates, livePeriodLabel } from "@/lib/domain/lives";
import { listSongKeys } from "@/lib/domain/songs";
import { MATERIAL_WINDOW_DAYS, TALK_SUGGEST_DAYS } from "@/lib/meetgreet/config";
import { formatDate } from "@/lib/utils";
import { MaterialsStep } from "@/components/materials-step";
import { applyMaterialsAction } from "../actions";
import { MetaForm } from "./meta-form";
import { SetlistForm } from "./setlist-form";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * ライブ 1 つ分の進行画面。公演 → 素材 → (レポ → スケッチ → 記事 は後続 PR) を縦に並べる。
 * ドシエ / /repo / 記事の中身はそれぞれの画面で扱い、ここからはリンクする。
 */
export default async function LiveDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) notFound();

  const live = await getLive(session.user, id);
  if (!live) notFound();

  const [candidates, songKeys] = await Promise.all([listMaterialCandidates(session.user, live), listSongKeys()]);
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
          </>
        ) : (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3">
            素材置き場のドシエが表示できません (所有者が非公開に戻したか、機密レベルが上がっています)。所有者にドシエの公開範囲を戻してもらってください。
          </p>
        )}
      </StepCard>

      {/* 3. レポ (ハッシュタグの設定と収集の実行は #150 で載る。収集画面へのリンクだけ出す) */}
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
              収集を開く <ExternalLink size={12} />
            </Link>
          ) : null
        }
      >
        <p className="text-xs text-slate-500">
          収集の実行と採用 / 不採用の判定は「収集を開く」先の画面で行えます (条件は #坂井新奈 のみ)。
          ライブごとのハッシュタグの設定はまだこの画面にありません。
        </p>
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
