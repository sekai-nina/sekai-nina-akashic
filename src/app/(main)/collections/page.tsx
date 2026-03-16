import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createCollection } from "@/lib/actions";
import { formatDate } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
  const session = await auth();
  const userId = session?.user?.id;

  const collections = await prisma.collection.findMany({
    where: userId ? { ownerId: userId } : {},
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { items: true } },
    },
  });

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">コレクション</h1>
        <p className="text-slate-500 text-sm mt-1">アセットのコレクション一覧</p>
      </div>

      {/* Create collection form */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">新規コレクション作成</h2>
        <form action={createCollection} className="space-y-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">名前 <span className="text-red-500">*</span></label>
            <input
              type="text"
              name="name"
              required
              className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="コレクション名"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">説明</label>
            <input
              type="text"
              name="description"
              className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="説明（任意）"
            />
          </div>
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            作成
          </button>
        </form>
      </div>

      {/* Collection list */}
      {collections.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <p>コレクションがありません</p>
          <p className="text-sm mt-1">上のフォームから作成してください</p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {collections.map((col) => (
            <Link
              key={col.id}
              href={`/collections/${col.id}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">{col.name}</p>
                {col.description && (
                  <p className="text-xs text-slate-500 mt-0.5 truncate">{col.description}</p>
                )}
                <p className="text-xs text-slate-400 mt-0.5">{formatDate(col.createdAt)}</p>
              </div>
              <div className="shrink-0 ml-4 text-right">
                <span className="text-sm font-semibold text-slate-700">{col._count.items}</span>
                <span className="text-xs text-slate-400 ml-1">件</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
