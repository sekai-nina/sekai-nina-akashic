import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import type { JobRunStatus, StatusLevel } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isDiscordConfigured } from "@/lib/status/discord";
import { listJobsWithRuns } from "@/lib/status/jobs";
import { countByLevel } from "@/lib/status/judge";
import {
  CHECK_GROUPS,
  CHECK_GROUP_LABELS,
  JOB_RUN_STATUS_LABELS,
  STATUS_LEVEL_BADGE,
  STATUS_LEVEL_LABELS,
  formatDate,
  formatRelative,
  type CheckGroup,
} from "@/lib/utils";
import { AdminControls } from "./admin-controls";
import { CheckDetail } from "./check-detail";

/** 状態のドットとバッジの色。他ページの状態バッジ (bg-*-100 text-*-700) に合わせる */
const LEVEL_STYLE: Record<StatusLevel, { dot: string; badge: string }> = {
  ok: { dot: "bg-emerald-500", badge: STATUS_LEVEL_BADGE.ok },
  warn: { dot: "bg-amber-500", badge: STATUS_LEVEL_BADGE.warn },
  error: { dot: "bg-red-500", badge: STATUS_LEVEL_BADGE.error },
  unknown: { dot: "bg-slate-300", badge: STATUS_LEVEL_BADGE.unknown },
};

const JOB_RUN_STATUS_STYLE: Record<JobRunStatus, string> = {
  ok: LEVEL_STYLE.ok.badge,
  error: LEVEL_STYLE.error.badge,
};

/** グループのセクションから関連ページへ飛ぶリンク */
const GROUP_LINKS: Partial<Record<CheckGroup, { href: string; label: string }>> = {
  collect: { href: "/coverage", label: "収集カバレッジ (観点ごとの確認状況)" },
  articles: { href: "/articles/push", label: "GitHub へ push" },
};

/**
 * パイプライン監視。収集・加工・記事・外部ワーカーの状態を俯瞰する (#100)。
 *
 * 表示は cron (`/api/cron/status`, 15 分ごと) が保存した StatusCheckState と、
 * ハートビートの Job / JobRun を読むだけ。どちらも非保護テーブルなので素の prisma。
 * ログイン済みなら誰でも見られる。admin には「今すぐ評価」「通知テスト」を出す。
 */
export default async function StatusPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const isAdmin = session.user.role === "admin";

  const [states, jobs] = await Promise.all([
    prisma.statusCheckState.findMany({ orderBy: { key: "asc" } }),
    listJobsWithRuns(10),
  ]);
  const now = new Date();
  const evaluatedAt = states.reduce<Date | null>(
    (acc, s) => (acc == null || s.evaluatedAt > acc ? s.evaluatedAt : acc),
    null,
  );
  const counts = countByLevel(states.filter((s) => isAdmin || s.group !== "costs").map((s) => s.status));

  // コストの行は金額こそ出さないが admin 専用ページ (/costs) の話なので、一覧にも admin にだけ出す
  const visibleGroups = isAdmin ? CHECK_GROUPS : CHECK_GROUPS.filter((g) => g !== "costs");
  const groups = visibleGroups.map((g) => ({
    group: g,
    // 保存された行に定義順は無いので、グループ内は状態の悪い順 → key 順で並べる (目に付くものを上に)
    items: states
      .filter((s) => s.group === g)
      .sort((a, b) => levelRank(b.status) - levelRank(a.status) || a.key.localeCompare(b.key)),
  }));

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">ステータス</h1>
        <p className="text-slate-500 text-sm mt-1">
          収集・加工・記事の同期・外部ワーカーが最新まで動いているかを 15 分ごとに評価します。
          注意・異常への変化と復旧は Discord に通知されます。
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg px-4 py-3 mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        {(["error", "warn", "ok", "unknown"] as StatusLevel[]).map((level) => (
          <span key={level} className="inline-flex items-center gap-1.5 text-sm">
            <span className={`w-2.5 h-2.5 rounded-full ${LEVEL_STYLE[level].dot}`} />
            {STATUS_LEVEL_LABELS[level]} <span className="font-semibold">{counts[level]}</span>
          </span>
        ))}
        <span className="text-xs text-slate-400 ml-auto">
          {evaluatedAt ? (
            <>
              最終評価 {formatDate(evaluatedAt, true)} ({formatRelative(evaluatedAt, now)})
            </>
          ) : (
            "まだ評価されていません"
          )}
        </span>
        {isAdmin && (
          <div className="w-full sm:w-auto sm:ml-4">
            <AdminControls discordConfigured={isDiscordConfigured()} />
          </div>
        )}
      </div>

      {states.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-3 mb-6">
          まだ一度も評価されていません。cron (<span className="font-mono">/api/cron/status</span>)
          が動いていないか、デプロイ直後です。
          {isAdmin && "「今すぐ評価」で最初の評価を走らせられます。"}
        </div>
      )}

      {groups.map(({ group, items }) =>
        items.length === 0 ? null : (
          <section key={group} className="mb-6">
            <h2 className="text-sm font-semibold text-slate-700 mb-2 flex items-baseline gap-3">
              {CHECK_GROUP_LABELS[group]}
              {GROUP_LINKS[group] && (
                <Link href={GROUP_LINKS[group].href} className="text-xs font-normal text-slate-500 hover:underline">
                  {GROUP_LINKS[group].label} →
                </Link>
              )}
            </h2>
            <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
              {items.map((s) => (
                <details key={s.key} className="group">
                  <summary className="px-4 py-2.5 flex items-center gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                    <ChevronRight size={14} className="shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${LEVEL_STYLE[s.status].dot}`} />
                    <span className="font-medium text-slate-900 shrink-0">{s.name}</span>
                    <span className="text-sm text-slate-600 truncate">{s.summary}</span>
                    <span className="ml-auto flex items-center gap-2 shrink-0">
                      {!s.notify && (
                        <span className="text-[10px] text-slate-400 border border-slate-200 rounded px-1">通知なし</span>
                      )}
                      <span className="text-xs text-slate-400 hidden sm:inline" title={`この状態になってから: ${formatDate(s.since, true)}`}>
                        {sinceLabel(s.since, now)}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${LEVEL_STYLE[s.status].badge}`}>
                        {STATUS_LEVEL_LABELS[s.status]}
                      </span>
                    </span>
                  </summary>
                  <div className="px-4 pb-3 pl-[3.75rem] space-y-2">
                    <p className="text-xs text-slate-400">{s.description}</p>
                    <CheckDetail detail={s.detail} />
                    <p className="text-[11px] text-slate-400">
                      <span className="font-mono">{s.key}</span> · 評価 {formatDate(s.evaluatedAt, true)}
                      {s.lastNotifiedAt && <> · 最終通知 {formatDate(s.lastNotifiedAt, true)}</>}
                    </p>
                  </div>
                </details>
              ))}
            </div>
          </section>
        ),
      )}

      <section className="mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-1">ハートビートの履歴</h2>
        <p className="text-xs text-slate-500 mb-2">
          bot / ワーカーが <span className="font-mono">POST /api/v1/jobs/{"{key}"}/runs</span> で報告した直近 10 回。
          何も無かった成功は 1 時間ごとにまとめられます。
        </p>
        {jobs.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center bg-white border border-slate-200 rounded-lg">
            まだ報告がありません
          </p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
            {jobs.map((job) => (
              <details key={job.id} className="group">
                <summary className="px-4 py-2.5 flex items-center gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                  <ChevronRight size={14} className="shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
                  <span className="font-medium text-slate-900">{job.name}</span>
                  <span className="text-xs text-slate-400 font-mono">{job.key}</span>
                  <span className="ml-auto text-xs text-slate-500 shrink-0">
                    最終報告 {job.lastRunAt ? formatRelative(job.lastRunAt, now) : "なし"}
                    {job.lastStatus && (
                      <span className={`ml-2 px-1.5 py-0.5 rounded ${JOB_RUN_STATUS_STYLE[job.lastStatus]}`}>
                        {JOB_RUN_STATUS_LABELS[job.lastStatus]}
                      </span>
                    )}
                  </span>
                </summary>
                <div className="px-4 pb-3">
                  <table className="w-full text-xs">
                    <tbody>
                      {job.runs.map((r) => (
                        <tr key={r.id} className="border-t border-slate-50">
                          <td className="py-1 pr-3 text-slate-500 whitespace-nowrap">{formatDate(r.createdAt, true)}</td>
                          <td className="py-1 pr-3 whitespace-nowrap">
                            <span className={`px-1.5 py-0.5 rounded ${JOB_RUN_STATUS_STYLE[r.status]}`}>
                              {JOB_RUN_STATUS_LABELS[r.status]}
                            </span>
                          </td>
                          <td className="py-1 pr-3 text-slate-500 whitespace-nowrap">
                            {r.count != null && `${r.count} 件`}
                            {r.durationMs != null && <span className="ml-2">{(r.durationMs / 1000).toFixed(1)}s</span>}
                          </td>
                          <td className="py-1 text-slate-700 font-mono break-all">{r.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function levelRank(level: StatusLevel): number {
  return { error: 3, warn: 2, unknown: 1, ok: 0 }[level];
}

/** 「3 分前から」。直近 1 分以内は「たった今から」だと読みにくいので「変化したばかり」に */
function sinceLabel(since: Date, now: Date): string {
  const rel = formatRelative(since, now);
  return rel === "たった今" ? "変化したばかり" : `${rel}から`;
}
