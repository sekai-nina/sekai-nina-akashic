import { prisma } from "@/lib/db";
import { QuickUploadForm } from "@/components/quick-upload-form";
import { InboxList } from "./inbox-list";
import Link from "next/link";

const PAGE_SIZE = 30;

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

  // Serialize for client component
  const serializedAssets = assets.map((a) => ({
    id: a.id,
    title: a.title,
    kind: a.kind,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
    sourceKind: a.sourceRecords[0]?.sourceKind,
  }));

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Inbox</h1>
        <p className="text-slate-500 text-sm mt-1">未整理のアセット一覧 — {total} 件</p>
      </div>

      <QuickUploadForm />

      <InboxList assets={serializedAssets} />

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
