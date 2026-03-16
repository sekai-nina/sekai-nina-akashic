import { prisma } from "@/lib/db";
import { quickCreateAsset, updateAssetStatus } from "@/lib/actions";
import { ASSET_KIND_LABELS, ASSET_STATUS_LABELS, formatDate } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    inbox: "bg-yellow-100 text-yellow-800",
    triaging: "bg-blue-100 text-blue-800",
    organized: "bg-green-100 text-green-800",
    archived: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? "bg-slate-100 text-slate-600"}`}>
      {ASSET_STATUS_LABELS[status] ?? status}
    </span>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
      {ASSET_KIND_LABELS[kind] ?? kind}
    </span>
  );
}

export default async function InboxPage() {
  const assets = await prisma.asset.findMany({
    where: { status: "inbox" },
    orderBy: { createdAt: "desc" },
    include: {
      sourceRecords: { take: 1 },
    },
  });

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Inbox</h1>
        <p className="text-slate-500 text-sm mt-1">未整理のアセット一覧</p>
      </div>

      {/* Quick create form */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">クイック登録</h2>
        <form action={quickCreateAsset} className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs text-slate-500 mb-1">タイトル</label>
            <input
              type="text"
              name="title"
              placeholder="タイトルを入力"
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">種別</label>
            <select
              name="kind"
              className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {Object.entries(ASSET_KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-slate-500 mb-1">URL（任意）</label>
            <input
              type="url"
              name="storageUrl"
              placeholder="https://..."
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            登録
          </button>
        </form>
      </div>

      {/* Asset list */}
      {assets.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <p className="text-lg">Inboxは空です</p>
          <p className="text-sm mt-1">上のフォームからアセットを登録してください</p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {assets.map((asset) => {
            const toTriaging = updateAssetStatus.bind(null, asset.id, "triaging");
            const toOrganized = updateAssetStatus.bind(null, asset.id, "organized");

            return (
              <div key={asset.id} className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50">
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/assets/${asset.id}`}
                    className="text-sm font-medium text-slate-900 hover:text-blue-700 truncate block"
                  >
                    {asset.title || "(無題)"}
                  </Link>
                  <div className="flex items-center gap-2 mt-1">
                    <KindBadge kind={asset.kind} />
                    <StatusBadge status={asset.status} />
                    <span className="text-xs text-slate-400">{formatDate(asset.createdAt)}</span>
                    {asset.sourceRecords[0] && (
                      <span className="text-xs text-slate-400">{asset.sourceRecords[0].sourceKind}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <form action={toTriaging}>
                    <button
                      type="submit"
                      className="text-xs border border-blue-300 text-blue-700 px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                    >
                      整理中へ
                    </button>
                  </form>
                  <form action={toOrganized}>
                    <button
                      type="submit"
                      className="text-xs border border-green-300 text-green-700 px-2 py-1 rounded hover:bg-green-50 transition-colors"
                    >
                      整理済みへ
                    </button>
                  </form>
                  <Link
                    href={`/assets/${asset.id}`}
                    className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
                  >
                    詳細
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 text-sm text-slate-400">
        {assets.length} 件
      </div>
    </div>
  );
}
