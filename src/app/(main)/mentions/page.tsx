import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getExcludedUsernames, getLastRun, listRecentHits, listWatches } from "@/lib/domain/x-mentions";
import { isMentionDiscordConfigured } from "@/lib/x-mentions/run";
import { formatRelative } from "@/lib/utils";
import { ExclusionForm } from "./exclusion-form";
import { HitList } from "./hit-list";
import { RunControls } from "./run-controls";
import { WatchList } from "./watch-list";

/**
 * X 言及監視 — 監視語 (X の検索クエリ) を毎日 09:00 JST に recent search し、
 * 除外ユーザー以外の投稿を Discord に流す。ここで監視語と除外ユーザーを管理し、拾ったものを眺める。
 */
export const dynamic = "force-dynamic";
// 「今すぐ実行」は cron と同じ処理 (X API + Discord 連投) を Server Action で走らせるので、cron と同じ長さ
export const maxDuration = 300;

const HIT_LIMIT = 100;

export default async function MentionsPage() {
  const session = await auth();
  if (!session?.user) notFound();
  const { clearance, role } = session.user;
  const canEdit = role === "admin" || role === "member";

  const [watches, excluded, hits, lastRun] = await Promise.all([
    listWatches(clearance),
    getExcludedUsernames(clearance),
    listRecentHits(clearance, HIT_LIMIT),
    getLastRun(),
  ]);
  // 相対時刻はここ (サーバー) で文字列にする。クライアントで計算すると hydration で食い違う
  const now = new Date();
  const watchItems = watches.map((w) => ({
    ...w,
    lastCheckedLabel: w.lastCheckedAt ? `最終確認 ${formatRelative(w.lastCheckedAt, now)}` : "未実行",
  }));
  const lastRunLabel = lastRun ? { relative: formatRelative(lastRun.at, now), ok: lastRun.ok, message: lastRun.message } : null;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">X 言及監視</h1>
        <p className="text-slate-500 text-sm mt-1">
          監視語を毎日 09:00 に X で検索し、除外ユーザー以外の投稿を Discord に流す（X API v2 recent search / 直近7日）
        </p>
      </div>

      <RunControls canEdit={canEdit} discordConfigured={isMentionDiscordConfigured()} lastRun={lastRunLabel} />

      <section className="mt-8">
        <h2 className="text-sm font-medium text-slate-500 mb-3">監視語</h2>
        <WatchList items={watchItems} canEdit={canEdit} />
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-slate-500 mb-3">除外ユーザー（全監視語で共通）</h2>
        <ExclusionForm usernames={excluded} canEdit={canEdit} />
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-slate-500 mb-3">直近のヒット（新しい順に {HIT_LIMIT} 件まで）</h2>
        <HitList items={hits} />
      </section>
    </div>
  );
}
