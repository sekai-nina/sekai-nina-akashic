import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { formatJpDate, getMeetGreet, listMaterialCandidates } from "@/lib/domain/meetgreets";
import { formatDate, MEETGREET_FORMAT_LABELS } from "@/lib/utils";
import { MetaForm } from "./meta-form";
import { MaterialsStep } from "./materials-step";
import { ReportsStep } from "./reports-step";

interface Props {
  params: Promise<{ id: string }>;
}

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

  const candidates = await listMaterialCandidates(session.user, mg);
  const suggestedCount = candidates.reduce(
    (n, g) => n + g.assets.filter((a) => a.suggested).length,
    0
  );

  const title = `${formatJpDate(mg.date)} ${mg.label}${MEETGREET_FORMAT_LABELS[mg.format]}ミーグリ`;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <Link href="/meetgreets" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> ミーグリ一覧へ
      </Link>

      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        <p className="text-xs text-slate-500 mt-1">
          作成 {formatDate(mg.createdAt)} · {mg.createdBy.name}
        </p>
        <MetaForm id={mg.id} single={mg.single} label={mg.label} />
      </div>

      {/* 1. 素材 */}
      <StepCard
        no={1}
        title="素材"
        done={mg.dossier._count.items > 0}
        summary={`ドシエに ${mg.dossier._count.items} 件`}
        action={
          <Link href={`/dossiers/${mg.dossierId}`} className={linkCls}>
            ドシエを開く <ExternalLink size={12} />
          </Link>
        }
      >
        <p className="text-xs text-slate-500 mb-3">
          当日〜10 日後のブログ・トークから候補を出しています。本文にミーグリの話があるブログと、当日〜翌日のトーク画像 / 動画は最初からチェック済み ({suggestedCount} 件)。外す / 足すだけして「ドシエに反映」を押してください。抜粋 (本人の感想) はドシエ側で範囲選択します。
        </p>
        <MaterialsStep meetGreetId={mg.id} groups={candidates} />
      </StepCard>

      {/* 2. レポ */}
      <StepCard
        no={2}
        title="X レポ"
        done={(mg.reports?.keep ?? 0) > 0}
        summary={
          mg.reports
            ? `keep ${mg.reports.keep} / 取得 ${mg.reports.total}${mg.repoCollection?.lastFetchedAt ? ` · 最終収集 ${formatDate(mg.repoCollection.lastFetchedAt, true)}` : ""}`
            : "収集が紐づいていません"
        }
        action={
          mg.repoCollectionId ? (
            <Link href={`/repo/${mg.repoCollectionId}`} className={linkCls}>
              レポを判定する <ExternalLink size={12} />
            </Link>
          ) : null
        }
      >
        <p className="text-xs text-slate-500 mb-3">
          収集は作成時に 1 回走っています (X の recent search は直近 7 日まで)。翌日以降の投稿を拾うときや、作成時に失敗したときは再収集してください。keep にしたツイートは記事生成がそのまま読みます。
        </p>
        <ReportsStep meetGreetId={mg.id} hasCollection={!!mg.repoCollectionId} />
      </StepCard>

      {/* 3. スケッチ */}
      <StepCard no={3} title="スケッチ" done={!!mg.sketchKey} summary={mg.sketchKey ? "確定済み" : "未生成"}>
        <p className="text-xs text-slate-400">
          ドシエの画像を参照にスケッチを生成する機能は次の PR (#108) で入ります。それまでは従来どおり ChatGPT で作り、ドシエに「サムネ」として追加してください。
        </p>
      </StepCard>

      {/* 4. 記事 */}
      <StepCard
        no={4}
        title="記事"
        done={!!mg.article}
        summary={mg.article ? `${mg.article.title} (${mg.article.dirty ? "未 push" : "push 済み"})` : "未生成"}
        action={
          mg.article ? (
            <Link href={`/articles/${mg.article.shortId}`} className={linkCls}>
              記事を開く <ExternalLink size={12} />
            </Link>
          ) : null
        }
      >
        <p className="text-xs text-slate-400">
          ドシエと keep したレポから記事を生成する機能は #109 で入ります。それまでは従来どおりローカルの dossier-to-meetgreet-article スキルで生成してください。
        </p>
      </StepCard>
    </div>
  );
}

const linkCls =
  "inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 underline underline-offset-2";

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
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <span className="text-xs text-slate-500 truncate">{summary}</span>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
