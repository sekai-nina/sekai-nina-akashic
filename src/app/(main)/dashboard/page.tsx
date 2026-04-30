import {
  getCachedDashboardStats,
  getCachedKindCounts,
  getCachedStatusCounts,
  getCachedRecentAssets,
  getCachedInboxCount,
} from "@/lib/cache";
import { ASSET_KIND_LABELS, ASSET_STATUS_LABELS, formatDate } from "@/lib/utils";
import Link from "next/link";
import { Inbox, Plus } from "lucide-react";

export default async function DashboardPage() {
  const [stats, kindCounts, statusCounts, recentAssets, inboxCount] =
    await Promise.all([
      getCachedDashboardStats(),
      getCachedKindCounts(),
      getCachedStatusCounts(),
      getCachedRecentAssets(),
      getCachedInboxCount(),
    ]);

  const totalMedia =
    stats.media.hinaai +
    stats.media.hinanari +
    stats.media.hinach +
    stats.media.official +
    stats.media.magazine;

  const statusColors: Record<string, string> = {
    inbox: "text-yellow-600",
    triaging: "text-blue-600",
    organized: "text-green-600",
    archived: "text-slate-400",
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <Link
          href="/assets/new"
          className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          <Plus size={14} />
          新規登録
        </Link>
      </div>

      {/* Inbox Alert */}
      {inboxCount > 0 && (
        <Link
          href="/inbox"
          className="flex items-center gap-3 bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 hover:bg-yellow-100 transition-colors"
        >
          <Inbox size={18} className="text-yellow-600" />
          <span className="text-sm text-yellow-800">
            <strong>{inboxCount}</strong> 件の未整理アセット
          </span>
          <span className="ml-auto text-xs text-yellow-600">確認する →</span>
        </Link>
      )}

      {/* Two-column: Stats + Recent */}
      <div className="grid md:grid-cols-5 gap-6">
        {/* Left: Stats */}
        <div className="md:col-span-2 space-y-5">
          {/* Overview card */}
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <p className="text-3xl font-bold text-slate-900">
              {stats.total.assetCount.toLocaleString()}
            </p>
            <p className="text-xs text-slate-500 mt-0.5 mb-4">総アセット数</p>

            {/* Kind inline list */}
            <div className="space-y-1.5">
              {kindCounts.map(({ kind, _count }) => (
                <Link
                  key={kind}
                  href={`/assets?kind=${kind}`}
                  className="flex items-center justify-between py-1 hover:bg-slate-50 -mx-2 px-2 rounded transition-colors"
                >
                  <span className="text-sm text-slate-600">
                    {ASSET_KIND_LABELS[kind] ?? kind}
                  </span>
                  <span className="text-sm font-semibold text-slate-900">
                    {(typeof _count === 'number' ? _count : ((_count as Record<string, number>)?._all ?? 0)).toLocaleString()}
                  </span>
                </Link>
              ))}
            </div>

            {/* Status inline */}
            <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap gap-x-4 gap-y-1">
              {(["inbox", "triaging", "organized", "archived"] as const).map(
                (status) => {
                  const raw = statusCounts.find((s) => s.status === status)?._count;
                  const count = typeof raw === 'number' ? raw : ((raw as Record<string, number>)?._all ?? 0);
                  return (
                    <Link
                      key={status}
                      href={`/assets?status=${status}`}
                      className="flex items-center gap-1.5 text-xs hover:underline"
                    >
                      <span className={`font-semibold ${statusColors[status]}`}>
                        {count}
                      </span>
                      <span className="text-slate-500">
                        {ASSET_STATUS_LABELS[status]}
                      </span>
                    </Link>
                  );
                }
              )}
            </div>
          </div>

          {/* Nina stats card */}
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
              坂井新奈
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <Link href="/search?mode=text&sourceType=web" className="group">
                <p className="text-2xl font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                  {stats.blog.postCount}
                </p>
                <p className="text-xs text-slate-500">ブログ</p>
                <p className="text-xs text-slate-400">
                  {stats.blog.totalChars.toLocaleString()} 字
                </p>
              </Link>
              <Link href="/search?mode=text&sourceType=import" className="group">
                <p className="text-2xl font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                  {stats.talk.messageCount.toLocaleString()}
                </p>
                <p className="text-xs text-slate-500">トーク</p>
                <p className="text-xs text-slate-400">
                  {stats.talk.totalChars.toLocaleString()} 字
                </p>
              </Link>
              <Link href="/search?mode=media" className="group">
                <p className="text-2xl font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                  {totalMedia}
                </p>
                <p className="text-xs text-slate-500">メディア出演</p>
              </Link>
              <Link href="/search?mode=live" className="group">
                <p className="text-2xl font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                  {stats.live.count}
                </p>
                <p className="text-xs text-slate-500">ライブ</p>
                <p className="text-xs text-slate-400">
                  {stats.live.totalSongs} 曲 / C {stats.live.centerSongs}
                </p>
              </Link>
            </div>
          </div>
        </div>

        {/* Right: Recent activity */}
        <div className="md:col-span-3">
          <div className="bg-white border border-slate-200 rounded-lg">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-700">
                最近のアセット
              </h2>
              <Link
                href="/assets"
                className="text-xs text-slate-400 hover:text-slate-600"
              >
                すべて →
              </Link>
            </div>
            <div className="divide-y divide-slate-100">
              {recentAssets.map((asset) => (
                <Link
                  key={asset.id}
                  href={`/assets/${asset.id}`}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-900 truncate">
                      {asset.title || "(無題)"}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {ASSET_KIND_LABELS[asset.kind] ?? asset.kind}
                      {" · "}
                      {formatDate(asset.createdAt)}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
