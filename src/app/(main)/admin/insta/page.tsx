import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listInstaTargets, TIER_DEFAULT_MINUTES } from "@/lib/domain/insta-targets";
import { TargetForm } from "./target-form";

/**
 * insta-watch の監視対象。
 *
 * これまで対象は bot サーバの `config/accounts.txt` にしか無く、変えるには ssh が要った。
 * 「誰を見ているか」は運用判断なので画面から足せるようにする。bot は
 * `GET /api/v1/insta/targets` で読み、**最後に読めた一覧を保持する**ので、
 * ここが一時的に落ちても監視は止まらない。
 */
export const dynamic = "force-dynamic";

const TIER_LABELS = {
  hot: "高頻度",
  normal: "通常",
  cold: "低頻度",
} as const;

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export default async function AdminInstaPage() {
  const session = await auth();
  if (!session?.user) notFound();
  if (session.user.role !== "admin") notFound();

  const targets = await listInstaTargets(session.user.clearance);
  const enabled = targets.filter((t) => t.enabled);

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Instagram の監視対象</h1>
        <p className="text-slate-500 text-sm mt-1">
          insta-watch が新規投稿を見張るアカウント。反映は次の巡回からです。
          <span className="font-medium text-slate-700">
            件数を増やすほど 1 アカウントあたりの間隔は自動で伸びます
          </span>
          （出口 IP あたりの上限を超えないため）。どうでもいい対象を低頻度にするほど、
          高頻度の対象を速く保てます。
        </p>
      </div>

      <TargetForm />

      <div className="mt-6 border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs">
            <tr>
              <th className="text-left font-medium px-4 py-2">ハンドル</th>
              <th className="text-left font-medium px-4 py-2">頻度</th>
              <th className="text-left font-medium px-4 py-2">間隔</th>
              <th className="text-left font-medium px-4 py-2">メモ</th>
              <th className="text-left font-medium px-4 py-2">更新</th>
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
              <tr key={t.id} className={`border-t border-slate-100 ${t.enabled ? "" : "bg-slate-50 text-slate-400"}`}>
                <td className="px-4 py-2 font-mono">
                  <a
                    href={`https://www.instagram.com/${t.handle}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {t.handle}
                  </a>
                  {!t.enabled && <span className="ml-2 text-xs">（停止中）</span>}
                </td>
                <td className="px-4 py-2">{TIER_LABELS[t.tier]}</td>
                <td className="px-4 py-2">
                  {t.effectiveMinutes} 分
                  {t.intervalMinutes == null && (
                    <span className="text-xs text-slate-400 ml-1">（既定）</span>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-500">{t.note}</td>
                <td className="px-4 py-2 text-xs text-slate-400">
                  {formatJst(t.updatedAt)}
                  {t.updatedByName && <> / {t.updatedByName}</>}
                </td>
                <td className="px-4 py-2 text-right">
                  <TargetForm.RowActions id={t.id} enabled={t.enabled} handle={t.handle} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400 mt-3">
        有効 {enabled.length} 件 / 全 {targets.length} 件。既定の間隔は
        高頻度 {TIER_DEFAULT_MINUTES.hot} 分・通常 {TIER_DEFAULT_MINUTES.normal} 分・
        低頻度 {TIER_DEFAULT_MINUTES.cold} 分です。
      </p>
    </div>
  );
}
