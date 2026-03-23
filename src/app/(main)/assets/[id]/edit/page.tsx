import { prisma } from "@/lib/db";
import { updateAsset } from "@/lib/actions";
import {
  ASSET_KIND_LABELS,
  ASSET_STATUS_LABELS,
  TRUST_LEVEL_LABELS,
} from "@/lib/utils";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AssetEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset) notFound();

  const action = updateAsset.bind(null, id);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-slate-400 mb-2">
          <Link href="/assets" className="hover:text-slate-600">アセット一覧</Link>
          <span>/</span>
          <Link href={`/assets/${id}`} className="hover:text-slate-600 truncate">
            {asset.title || "(無題)"}
          </Link>
          <span>/</span>
          <span className="text-slate-600">編集</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">アセットを編集</h1>
      </div>

      <form action={action} className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        {/* Title */}
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-slate-700 mb-1">
            タイトル
          </label>
          <input
            type="text"
            id="title"
            name="title"
            defaultValue={asset.title}
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Description */}
        <div>
          <label htmlFor="description" className="block text-sm font-medium text-slate-700 mb-1">
            説明
          </label>
          <textarea
            id="description"
            name="description"
            rows={4}
            defaultValue={asset.description}
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Kind */}
          <div>
            <label htmlFor="kind" className="block text-sm font-medium text-slate-700 mb-1">
              種別
            </label>
            <select
              id="kind"
              name="kind"
              defaultValue={asset.kind}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {Object.entries(ASSET_KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {/* Status */}
          <div>
            <label htmlFor="status" className="block text-sm font-medium text-slate-700 mb-1">
              ステータス
            </label>
            <select
              id="status"
              name="status"
              defaultValue={asset.status}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {Object.entries(ASSET_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {/* Trust Level */}
          <div>
            <label htmlFor="trustLevel" className="block text-sm font-medium text-slate-700 mb-1">
              信頼度
            </label>
            <select
              id="trustLevel"
              name="trustLevel"
              defaultValue={asset.trustLevel}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {Object.entries(TRUST_LEVEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {/* Source Type */}
          <div>
            <label htmlFor="sourceType" className="block text-sm font-medium text-slate-700 mb-1">
              ソース種別
            </label>
            <select
              id="sourceType"
              name="sourceType"
              defaultValue={asset.sourceType}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="web">Web</option>
              <option value="manual">手動</option>
              <option value="discord">Discord</option>
              <option value="import">インポート</option>
            </select>
          </div>
        </div>

        {/* Canonical Date */}
        <div>
          <label htmlFor="canonicalDate" className="block text-sm font-medium text-slate-700 mb-1">
            基準日
          </label>
          <input
            type="date"
            id="canonicalDate"
            name="canonicalDate"
            defaultValue={asset.canonicalDate?.toISOString().split("T")[0] ?? ""}
            className="border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Storage URL */}
        <div>
          <label htmlFor="storageUrl" className="block text-sm font-medium text-slate-700 mb-1">
            ストレージURL
          </label>
          <input
            type="text"
            id="storageUrl"
            name="storageUrl"
            defaultValue={asset.storageUrl ?? ""}
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            保存
          </button>
          <Link
            href={`/assets/${id}`}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            キャンセル
          </Link>
        </div>
      </form>
    </div>
  );
}
