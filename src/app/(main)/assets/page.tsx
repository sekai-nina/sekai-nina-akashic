import { prisma } from "@/lib/db";
import { ASSET_KIND_LABELS, ASSET_STATUS_LABELS, TRUST_LEVEL_LABELS, formatDate } from "@/lib/utils";
import Link from "next/link";
import type { AssetKind, AssetStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

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

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; kind?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1"));
  const statusFilter = params.status as AssetStatus | undefined;
  const kindFilter = params.kind as AssetKind | undefined;

  const where = {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(kindFilter ? { kind: kindFilter } : {}),
  };

  const [assets, total] = await Promise.all([
    prisma.asset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        sourceRecords: { take: 1 },
      },
    }),
    prisma.asset.count({ where }),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  function buildUrl(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    if (overrides.page ?? params.page) p.set("page", overrides.page ?? params.page ?? "1");
    if (overrides.status !== undefined ? overrides.status : params.status)
      p.set("status", (overrides.status !== undefined ? overrides.status : params.status)!);
    if (overrides.kind !== undefined ? overrides.kind : params.kind)
      p.set("kind", (overrides.kind !== undefined ? overrides.kind : params.kind)!);
    return `/assets?${p.toString()}`;
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">アセット一覧</h1>
          <p className="text-slate-500 text-sm mt-1">全 {total} 件</p>
        </div>
        <Link
          href="/assets/new"
          className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + 新規登録
        </Link>
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 mb-4 flex flex-wrap gap-3 items-center">
        <span className="text-sm text-slate-600 font-medium">フィルター</span>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">ステータス</label>
          <select
            className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            defaultValue={statusFilter ?? ""}
            onChange={undefined}
            // Use form-based navigation
            name="status"
            form="filter-form"
          >
            <option value="">すべて</option>
            {Object.entries(ASSET_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">種別</label>
          <select
            className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            defaultValue={kindFilter ?? ""}
            name="kind"
            form="filter-form"
          >
            <option value="">すべて</option>
            {Object.entries(ASSET_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <form id="filter-form" method="GET" action="/assets">
          <input type="hidden" name="page" value="1" />
          <button
            type="submit"
            className="bg-slate-700 text-white px-3 py-1 rounded text-sm hover:bg-slate-800 transition-colors"
          >
            適用
          </button>
        </form>
        {(statusFilter || kindFilter) && (
          <Link href="/assets" className="text-sm text-slate-400 hover:text-slate-600">
            クリア
          </Link>
        )}
      </div>

      {/* Asset table */}
      {assets.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <p>アセットが見つかりません</p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-600">タイトル</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-600">種別</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-600">ステータス</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-600">信頼度</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-600">日付</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-600">出典</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {assets.map((asset) => (
                <tr key={asset.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/assets/${asset.id}`}
                      className="font-medium text-slate-900 hover:text-blue-700 line-clamp-1"
                    >
                      {asset.title || "(無題)"}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <KindBadge kind={asset.kind} />
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={asset.status} />
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {TRUST_LEVEL_LABELS[asset.trustLevel] ?? asset.trustLevel}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {formatDate(asset.createdAt)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-400">
                    {asset.sourceRecords[0]?.sourceKind ?? asset.sourceType}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-slate-500">
            {page} / {totalPages} ページ
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={buildUrl({ page: String(page - 1) })}
                className="border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50"
              >
                ← 前へ
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={buildUrl({ page: String(page + 1) })}
                className="border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50"
              >
                次へ →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
