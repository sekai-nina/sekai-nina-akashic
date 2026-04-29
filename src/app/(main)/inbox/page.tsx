import { prisma } from "@/lib/db";
import { updateAssetStatus } from "@/lib/actions";
import { ASSET_KIND_LABELS, ASSET_STATUS_LABELS, formatDate } from "@/lib/utils";
import { QuickUploadForm } from "@/components/quick-upload-form";
import { SubmitButton } from "@/components/submit-button";
import Link from "next/link";


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

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1"));

  const [assets, total] = await Promise.all([
    prisma.asset.findMany({
      where: { status: "inbox" },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        sourceRecords: { take: 1 },
      },
    }),
    prisma.asset.count({ where: { status: "inbox" } }),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Inbox</h1>
        <p className="text-slate-500 text-sm mt-1">未整理のアセット一覧 — {total} 件</p>
      </div>

      <QuickUploadForm />

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
              <div key={asset.id} className="px-4 py-3 hover:bg-slate-50 space-y-2">
                <Link
                  href={`/assets/${asset.id}`}
                  className="text-sm font-medium text-slate-900 hover:text-blue-700 truncate block"
                >
                  {asset.title || "(無題)"}
                </Link>
                <div className="flex items-center gap-2 flex-wrap">
                  <KindBadge kind={asset.kind} />
                  <StatusBadge status={asset.status} />
                  <span className="text-xs text-slate-400">{formatDate(asset.createdAt)}</span>
                  {asset.sourceRecords[0] && (
                    <span className="text-xs text-slate-400">{asset.sourceRecords[0].sourceKind}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <form action={toTriaging}>
                    <SubmitButton className="text-xs border border-blue-300 text-blue-700 px-2 py-1 rounded hover:bg-blue-50 transition-colors">
                      整理中へ
                    </SubmitButton>
                  </form>
                  <form action={toOrganized}>
                    <SubmitButton className="text-xs border border-green-300 text-green-700 px-2 py-1 rounded hover:bg-green-50 transition-colors">
                      整理済みへ
                    </SubmitButton>
                  </form>
                  <Link
                    href={`/assets/${asset.id}`}
                    className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 ml-auto"
                  >
                    詳細
                  </Link>
                </div>
              </div>
            );
          })}
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
                href={`/inbox?page=${page - 1}`}
                className="border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50"
              >
                ← 前へ
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/inbox?page=${page + 1}`}
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
