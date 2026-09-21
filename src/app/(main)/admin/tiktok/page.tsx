import Link from "next/link";
import { notFound } from "next/navigation";
import type { StatusLevel, TiktokVideoStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { listRecentTiktokVideos, listTiktokTargets } from "@/lib/domain/tiktok";
import { TIKTOK_JOB_KEY } from "@/lib/status/types";
import { MAX_ATTEMPTS, profileUrl, RECENT_VIDEOS_LIMIT, sourceEntityName } from "@/lib/tiktok/targets";
import {
  JOB_RUN_STATUS_LABELS,
  STATUS_LEVEL_BADGE,
  TIKTOK_VIDEO_STATUS_LABELS,
  formatDate,
  formatRelative,
} from "@/lib/utils";
import { RequeueButton, RowActions, TargetForm } from "./target-form";

/**
 * TikTok の監視対象と台帳 (#179)。
 *
 * Instagram (`/admin/insta`) と同じく対象は画面から足す。違いは「どの動画を取ったか」の
 * 台帳も akashic が持つこと。bot (tiktok-watch) は見えた動画を報告し、ここが返した分だけ
 * DL する。bot の生死は `/status` のジョブ `bot.tiktok_watch` で見る。
 */
export const dynamic = "force-dynamic";

/** 台帳の状態 → /status と同じバッジ配色 */
const VIDEO_STATUS_LEVEL: Record<TiktokVideoStatus, StatusLevel> = {
  registered: "ok",
  pending: "warn",
  failed: "error",
  skipped_initial: "unknown",
};

/** 台帳の件数を出す順 */
const COUNT_ORDER: { status: TiktokVideoStatus; className: string }[] = [
  { status: "registered", className: "" },
  { status: "pending", className: "text-amber-700" },
  { status: "failed", className: "text-red-700" },
  { status: "skipped_initial", className: "text-slate-400" },
];

export default async function AdminTiktokPage() {
  const session = await auth();
  if (!session?.user) notFound();
  if (session.user.role !== "admin") notFound();

  const [targets, videos, job] = await Promise.all([
    listTiktokTargets(session.user.clearance),
    listRecentTiktokVideos(session.user.clearance),
    // Job は非保護テーブル (件数・時刻・メッセージだけ)
    prisma.job.findUnique({ where: { key: TIKTOK_JOB_KEY } }),
  ]);
  const enabled = targets.filter((t) => t.enabled);
  const now = new Date();

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">TikTok の監視対象</h1>
        <p className="text-slate-500 text-sm mt-1">
          tiktok-watch が新着動画を見張るアカウント。新着は DL して akashic に登録し、Discord に流します。
          キャプションに出たメンバーは名簿から自動で紐付けます。反映は次の巡回からです。
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-6 text-sm">
        <h2 className="text-sm font-semibold text-slate-700 mb-1">bot の状態</h2>
        {job?.lastRunAt ? (
          <p className="text-slate-600">
            最終報告 {formatRelative(job.lastRunAt, now)}（
            <time dateTime={job.lastRunAt.toISOString()}>{formatDate(job.lastRunAt, true)}</time>）
            {job.lastStatus && (
              <span
                className={`ml-2 inline-block px-1.5 py-0.5 rounded text-xs ${STATUS_LEVEL_BADGE[job.lastStatus === "ok" ? "ok" : "error"]}`}
              >
                {JOB_RUN_STATUS_LABELS[job.lastStatus]}
              </span>
            )}
            {job.lastMessage && <span className="ml-2 text-slate-500">{job.lastMessage}</span>}
          </p>
        ) : (
          <p className="text-slate-500">まだ報告がありません（bot が動き出すとここに出ます）</p>
        )}
        <p className="text-xs text-slate-400 mt-1">
          途絶や失敗の通知は <Link href="/status" className="underline">/status</Link> のジョブ
          <span className="font-mono ml-1">{TIKTOK_JOB_KEY}</span> が担います。
        </p>
      </div>

      <TargetForm />

      <div className="mt-6 border border-slate-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs">
            <tr>
              <th className="text-left font-medium px-4 py-2">ハンドル</th>
              <th className="text-left font-medium px-4 py-2">間隔</th>
              <th className="text-left font-medium px-4 py-2">台帳</th>
              <th className="text-left font-medium px-4 py-2">最終確認</th>
              <th className="text-left font-medium px-4 py-2">メモ</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {targets.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  まだ 1 件も登録されていません
                </td>
              </tr>
            )}
            {targets.map((t) => (
              <tr
                key={t.id}
                className={`border-t border-slate-100 align-top ${t.enabled ? "" : "bg-slate-50 text-slate-400"}`}
              >
                <td className="px-4 py-2">
                  <a
                    href={profileUrl(t.handle)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono hover:underline"
                  >
                    {t.handle}
                  </a>
                  {!t.enabled && <span className="ml-2 text-xs">（停止中）</span>}
                  <div className="text-xs text-slate-400 mt-0.5">
                    出典: {sourceEntityName(t)}
                    {t.official && <span className="ml-1">/ 公式</span>}
                    {t.videoCount != null && <span className="ml-1">/ プロフィール {t.videoCount} 本</span>}
                  </div>
                </td>
                <td className="px-4 py-2">{t.intervalMinutes} 分</td>
                <td className="px-4 py-2 text-xs">
                  {COUNT_ORDER.filter((c) => c.status === "registered" || t.counts[c.status] > 0).map((c) => (
                    <div key={c.status} className={c.className}>
                      {TIKTOK_VIDEO_STATUS_LABELS[c.status]} {t.counts[c.status]}
                    </div>
                  ))}
                </td>
                <td className="px-4 py-2 text-xs">
                  {t.lastCheckedAt ? (
                    <time dateTime={t.lastCheckedAt.toISOString()} title={formatDate(t.lastCheckedAt, true)}>
                      {formatRelative(t.lastCheckedAt, now)}
                    </time>
                  ) : (
                    <span className="text-slate-400">未確認</span>
                  )}
                  {t.lastError && (
                    <div className="text-red-700 mt-0.5 max-w-xs">
                      {t.lastError}
                      {t.lastErrorAt && (
                        <span className="text-red-400 ml-1">({formatRelative(t.lastErrorAt, now)})</span>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-500 text-xs">
                  {t.note}
                  <div className="text-slate-400 mt-0.5">
                    {formatDate(t.updatedAt, true)}
                    {t.updatedByName && <> / {t.updatedByName}</>}
                  </div>
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  <RowActions id={t.id} enabled={t.enabled} handle={t.handle} failedCount={t.counts.failed} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400 mt-3">
        有効 {enabled.length} 件 / 全 {targets.length} 件。失敗は {MAX_ATTEMPTS} 回まで自動で再試行し、
        それを超えたものは「再試行」で戻します（一覧に出ない古い失敗は対象の「失敗 N 本を再試行」で）。
      </p>

      <h2 className="text-lg font-semibold text-slate-900 mt-8 mb-2">直近の動画</h2>
      <p className="text-xs text-slate-500 mb-3">
        bot が見た動画の新しい順 {RECENT_VIDEOS_LIMIT} 本。「{TIKTOK_VIDEO_STATUS_LABELS.skipped_initial}」は
        対象を足した時点で既に在った動画で、個別に取り込みたければ「取り込む」を押します
        （次の巡回で DL。Discord には流しません）。
      </p>
      <div className="border border-slate-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs">
            <tr>
              <th className="text-left font-medium px-4 py-2">投稿</th>
              <th className="text-left font-medium px-4 py-2">キャプション</th>
              <th className="text-left font-medium px-4 py-2">状態</th>
              <th className="text-left font-medium px-4 py-2">アセット</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {videos.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  まだ動画がありません
                </td>
              </tr>
            )}
            {videos.map((v) => (
              <tr key={v.id} className="border-t border-slate-100 align-top">
                <td className="px-4 py-2 text-xs whitespace-nowrap">
                  <a href={v.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                    <time dateTime={v.createTime.toISOString()}>{formatDate(v.createTime, true)}</time>
                  </a>
                  <div className="text-slate-400 font-mono">@{v.handle}</div>
                </td>
                <td className="px-4 py-2 text-xs text-slate-600 max-w-md">
                  <div className="line-clamp-2">{v.caption || <span className="text-slate-400">（なし）</span>}</div>
                </td>
                <td className="px-4 py-2 text-xs whitespace-nowrap">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded ${STATUS_LEVEL_BADGE[VIDEO_STATUS_LEVEL[v.status]]}`}
                  >
                    {TIKTOK_VIDEO_STATUS_LABELS[v.status]}
                  </span>
                  {v.status === "failed" && (
                    <div className="text-red-700 mt-0.5 max-w-xs whitespace-normal">
                      {v.attempts} 回目: {v.lastError}
                    </div>
                  )}
                  {v.notifiedAt ? (
                    <div className="text-slate-400 mt-0.5">通知済み</div>
                  ) : (
                    v.status === "registered" && v.notify && <div className="text-amber-700 mt-0.5">未通知</div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs">
                  {v.asset ? (
                    <Link href={`/assets/${v.assetId}`} className="flex items-center gap-2 hover:underline">
                      {v.asset.thumbnailUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={v.asset.thumbnailUrl} alt="" className="w-8 h-8 object-cover rounded" />
                      )}
                      <span className="line-clamp-2">{v.asset.title}</span>
                    </Link>
                  ) : v.assetId ? (
                    // 台帳は internal だがアセットは上げられている (閲覧者のクリアランスで見えない)
                    <span className="text-slate-400">（閲覧権限なし）</span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {v.status === "failed" && v.attempts >= MAX_ATTEMPTS && <RequeueButton id={v.id} label="再試行" />}
                  {v.status === "skipped_initial" && <RequeueButton id={v.id} label="取り込む" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
