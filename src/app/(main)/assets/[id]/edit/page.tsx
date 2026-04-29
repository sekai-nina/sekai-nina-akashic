import { prisma } from "@/lib/db";
import {
  updateAsset,
  deleteAsset,
  removeEntityFromAsset,
  deleteAssetText,
  deleteSourceRecord,
  deleteAnnotation,
} from "@/lib/actions";
import {
  ASSET_KIND_LABELS,
  ASSET_STATUS_LABELS,
  TRUST_LEVEL_LABELS,
  ENTITY_TYPE_LABELS,
  formatDate,
} from "@/lib/utils";
import { SubmitButton } from "@/components/submit-button";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";


const TEXT_TYPE_LABELS: Record<string, string> = {
  title: "タイトル",
  body: "本文",
  description: "説明",
  message_body: "メッセージ本文",
  ocr: "OCR",
  transcript: "文字起こし",
  note: "メモ",
  extracted: "抽出テキスト",
};

const SOURCE_KIND_LABELS: Record<string, string> = {
  url: "URL",
  discord_message: "Discordメッセージ",
  drive_file: "Driveファイル",
  manual: "手動",
  other: "その他",
};

const ANNOTATION_KIND_LABELS: Record<string, string> = {
  note: "メモ",
  time_range: "時間範囲",
  text_span: "テキストスパン",
  region: "リージョン",
};

export default async function AssetEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const asset = await prisma.asset.findUnique({
    where: { id },
    include: {
      texts: { orderBy: { createdAt: "asc" } },
      entities: {
        include: { entity: true },
        orderBy: { createdAt: "asc" },
      },
      sourceRecords: { orderBy: { createdAt: "asc" } },
      annotations: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!asset) notFound();

  const action = updateAsset.bind(null, id);
  const deleteAction = deleteAsset.bind(null, id);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-slate-400 mb-2">
          <Link href={`/assets/${id}`} replace className="flex items-center gap-1 hover:text-slate-600">
            <ArrowLeft size={14} />
            戻る
          </Link>
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
            日付
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
          <SubmitButton className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors">
            保存
          </SubmitButton>
          <Link
            href={`/assets/${id}`}
            replace
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            キャンセル
          </Link>
        </div>
      </form>

      {/* Entities */}
      {asset.entities.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">エンティティ</h2>
          <ul className="space-y-2">
            {asset.entities.map((ae) => {
              const removeAction = removeEntityFromAsset.bind(null, id, ae.entity.id);
              return (
                <li key={ae.entityId} className="flex items-center gap-3 text-sm">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">
                    {ENTITY_TYPE_LABELS[ae.entity.type] ?? ae.entity.type}
                  </span>
                  <span className="text-slate-800 font-medium">{ae.entity.canonicalName}</span>
                  {ae.roleLabel && <span className="text-slate-400 text-xs">({ae.roleLabel})</span>}
                  <form action={removeAction} className="ml-auto">
                    <SubmitButton className="text-xs text-red-500 hover:text-red-700">
                      削除
                    </SubmitButton>
                  </form>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Texts */}
      {asset.texts.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">テキスト</h2>
          <ul className="space-y-3">
            {asset.texts.map((text) => {
              const deleteAction = deleteAssetText.bind(null, text.id);
              return (
                <li key={text.id} className="border border-slate-100 rounded p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium bg-teal-100 text-teal-700 px-2 py-0.5 rounded">
                      {TEXT_TYPE_LABELS[text.textType] ?? text.textType}
                    </span>
                    <form action={deleteAction}>
                      <button type="submit" className="text-xs text-red-500 hover:text-red-700">
                        削除
                      </button>
                    </form>
                  </div>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap line-clamp-3">{text.content}</p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Source Records */}
      {asset.sourceRecords.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">出典記録</h2>
          <ul className="space-y-3">
            {asset.sourceRecords.map((src) => {
              const deleteAction = deleteSourceRecord.bind(null, src.id);
              return (
                <li key={src.id} className="border border-slate-100 rounded p-3 text-sm">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium bg-orange-100 text-orange-700 px-2 py-0.5 rounded">
                      {SOURCE_KIND_LABELS[src.sourceKind] ?? src.sourceKind}
                    </span>
                    <form action={deleteAction}>
                      <button type="submit" className="text-xs text-red-500 hover:text-red-700">
                        削除
                      </button>
                    </form>
                  </div>
                  <p className="font-medium text-slate-800">{src.title || "(タイトルなし)"}</p>
                  {src.url && (
                    <span className="text-xs text-slate-500 break-all">{src.url}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Annotations */}
      {asset.annotations.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">アノテーション</h2>
          <ul className="space-y-3">
            {asset.annotations.map((ann) => {
              const deleteAction = deleteAnnotation.bind(null, ann.id);
              return (
                <li key={ann.id} className="border border-slate-100 rounded p-3 text-sm">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded">
                      {ANNOTATION_KIND_LABELS[ann.kind] ?? ann.kind}
                    </span>
                    <form action={deleteAction}>
                      <button type="submit" className="text-xs text-red-500 hover:text-red-700">
                        削除
                      </button>
                    </form>
                  </div>
                  <p className="text-slate-700 whitespace-pre-wrap line-clamp-3">{ann.body}</p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Danger zone */}
      <div className="border border-red-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-red-600 mb-2">アセットの削除</h2>
        <p className="text-xs text-slate-500 mb-3">
          このアセットとそれに紐づくすべてのデータ（テキスト、出典、アノテーション等）が完全に削除されます。この操作は取り消せません。
        </p>
        <form action={deleteAction}>
          <SubmitButton className="text-xs bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 transition-colors">
            このアセットを削除する
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
