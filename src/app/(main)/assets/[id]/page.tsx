import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import {
  updateAssetStatus,
  addEntityToAsset,
  addAssetText,
  addSourceRecord,
  addAnnotation,
  addToCollection,
} from "@/lib/actions";
import {
  ASSET_KIND_LABELS,
  ASSET_STATUS_LABELS,
  TRUST_LEVEL_LABELS,
  ENTITY_TYPE_LABELS,
  formatDate,
} from "@/lib/utils";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

async function addToCollectionAction(assetId: string, formData: FormData) {
  "use server";
  const collectionId = formData.get("collectionId") as string;
  if (collectionId) await addToCollection(collectionId, assetId);
}

function AddToCollectionForm({
  assetId,
  collections,
}: {
  assetId: string;
  collections: { id: string; name: string }[];
}) {
  const action = addToCollectionAction.bind(null, assetId);
  return (
    <form action={action} className="flex gap-3 items-end">
      <div className="flex-1">
        <label className="block text-xs text-slate-500 mb-1">コレクション</label>
        <select
          name="collectionId"
          className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {collections.map((col) => (
            <option key={col.id} value={col.id}>{col.name}</option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        className="bg-slate-700 text-white px-3 py-1.5 rounded text-sm hover:bg-slate-800 transition-colors"
      >
        追加
      </button>
    </form>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    inbox: "bg-yellow-100 text-yellow-800",
    triaging: "bg-blue-100 text-blue-800",
    organized: "bg-green-100 text-green-800",
    archived: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium ${colors[status] ?? "bg-slate-100 text-slate-600"}`}>
      {ASSET_STATUS_LABELS[status] ?? status}
    </span>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
      {ASSET_KIND_LABELS[kind] ?? kind}
    </span>
  );
}

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

export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();

  const [asset, collections] = await Promise.all([
    prisma.asset.findUnique({
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
    }),
    session?.user
      ? prisma.collection.findMany({
          where: { ownerId: session.user.id },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
  ]);

  if (!asset) notFound();

  // Check for duplicate by sha256
  let duplicates: { id: string; title: string }[] = [];
  if (asset.sha256) {
    duplicates = await prisma.asset.findMany({
      where: { sha256: asset.sha256, id: { not: id } },
      select: { id: true, title: true },
    });
  }

  const isImage = asset.kind === "image";
  let previewUrl = asset.thumbnailUrl;
  if (isImage) {
    if (asset.storageProvider === "gdrive" && asset.storageKey) {
      // Drive の webViewLink は img src に使えないのでプロキシ経由にする
      previewUrl = `/api/drive-image/${asset.storageKey}`;
    } else if (!previewUrl) {
      previewUrl = asset.storageUrl;
    }
  }

  // Status workflow
  const statusWorkflow: Array<{ from: string; to: "inbox" | "triaging" | "organized" | "archived"; label: string }> = [
    { from: "inbox", to: "triaging", label: "整理中へ" },
    { from: "triaging", to: "organized", label: "整理済みへ" },
    { from: "triaging", to: "inbox", label: "Inboxに戻す" },
    { from: "organized", to: "archived", label: "アーカイブ" },
    { from: "organized", to: "triaging", label: "整理中に戻す" },
    { from: "archived", to: "organized", label: "整理済みに戻す" },
  ];
  const availableTransitions = statusWorkflow.filter((t) => t.from === asset.status);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-slate-400 mb-2">
            <Link href="/assets" className="hover:text-slate-600">アセット一覧</Link>
            <span>/</span>
            <span className="text-slate-600 truncate">{asset.title || "(無題)"}</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">{asset.title || "(無題)"}</h1>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <KindBadge kind={asset.kind} />
            <StatusBadge status={asset.status} />
            <span className="text-xs text-slate-400">登録: {formatDate(asset.createdAt)}</span>
            {asset.canonicalDate && (
              <span className="text-xs text-slate-400">基準日: {formatDate(asset.canonicalDate)}</span>
            )}
          </div>
        </div>
        <Link
          href={`/assets/${id}/edit`}
          className="shrink-0 border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50 transition-colors"
        >
          編集
        </Link>
      </div>

      {/* Duplicate warning */}
      {duplicates.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-3 text-sm text-yellow-800">
          <strong>重複の可能性:</strong> 同じファイルが他のアセットにも存在します。
          {duplicates.map((d) => (
            <span key={d.id}>
              {" "}
              <Link href={`/assets/${d.id}`} className="underline hover:text-yellow-900">
                {d.title || "(無題)"}
              </Link>
            </span>
          ))}
        </div>
      )}

      {/* Image preview */}
      {previewUrl && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt={asset.title || "プレビュー"}
            className="max-h-96 max-w-full object-contain rounded"
          />
        </div>
      )}

      {/* Metadata */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">メタデータ</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-slate-500 shrink-0">信頼度:</dt>
            <dd className="text-slate-800">{TRUST_LEVEL_LABELS[asset.trustLevel] ?? asset.trustLevel}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-slate-500 shrink-0">ソース種別:</dt>
            <dd className="text-slate-800">{asset.sourceType}</dd>
          </div>
          {asset.storageProvider && (
            <div className="flex gap-2">
              <dt className="text-slate-500 shrink-0">プロバイダー:</dt>
              <dd className="text-slate-800">{asset.storageProvider}</dd>
            </div>
          )}
          {asset.originalFilename && (
            <div className="flex gap-2">
              <dt className="text-slate-500 shrink-0">ファイル名:</dt>
              <dd className="text-slate-800 truncate">{asset.originalFilename}</dd>
            </div>
          )}
          {asset.mimeType && (
            <div className="flex gap-2">
              <dt className="text-slate-500 shrink-0">MIMEタイプ:</dt>
              <dd className="text-slate-800">{asset.mimeType}</dd>
            </div>
          )}
          {asset.fileSize != null && (
            <div className="flex gap-2">
              <dt className="text-slate-500 shrink-0">サイズ:</dt>
              <dd className="text-slate-800">{asset.fileSize.toLocaleString()} bytes</dd>
            </div>
          )}
          {asset.sha256 && (
            <div className="col-span-2 flex gap-2">
              <dt className="text-slate-500 shrink-0">SHA256:</dt>
              <dd className="text-slate-800 font-mono text-xs break-all">{asset.sha256}</dd>
            </div>
          )}
        </dl>
        {asset.description && (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{asset.description}</p>
          </div>
        )}
        {asset.storageUrl && (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <a
              href={asset.storageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:text-blue-800 underline break-all"
            >
              ファイルを開く →
            </a>
          </div>
        )}
      </div>

      {/* Status workflow */}
      {availableTransitions.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">ステータス変更</h2>
          <div className="flex gap-2 flex-wrap">
            {availableTransitions.map((t) => {
              const action = updateAssetStatus.bind(null, id, t.to);
              return (
                <form key={t.to} action={action}>
                  <button
                    type="submit"
                    className="border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50 transition-colors"
                  >
                    {t.label}
                  </button>
                </form>
              );
            })}
          </div>
        </div>
      )}

      {/* Entities section */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">エンティティ</h2>
        {asset.entities.length === 0 ? (
          <p className="text-sm text-slate-400 mb-3">エンティティなし</p>
        ) : (
          <ul className="space-y-2 mb-4">
            {asset.entities.map((ae) => (
                <li key={ae.entityId} className="flex items-center gap-3 text-sm">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">
                    {ENTITY_TYPE_LABELS[ae.entity.type] ?? ae.entity.type}
                  </span>
                  <span className="text-slate-800 font-medium">{ae.entity.canonicalName}</span>
                  {ae.roleLabel && <span className="text-slate-400 text-xs">({ae.roleLabel})</span>}
                </li>
            ))}
          </ul>
        )}
        <details className="border border-slate-200 rounded p-3">
          <summary className="text-sm text-slate-600 cursor-pointer hover:text-slate-800">エンティティを追加</summary>
          <form action={addEntityToAsset.bind(null, id)} className="mt-3 flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs text-slate-500 mb-1">タイプ</label>
              <select
                name="entityType"
                className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {Object.entries(ENTITY_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-[160px]">
              <label className="block text-xs text-slate-500 mb-1">正規名 <span className="text-red-500">*</span></label>
              <input
                type="text"
                name="canonicalName"
                required
                className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="例: 星乃一歌"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">役割ラベル</label>
              <input
                type="text"
                name="roleLabel"
                className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="例: 主体"
              />
            </div>
            <button
              type="submit"
              className="bg-purple-600 text-white px-3 py-1 rounded text-sm hover:bg-purple-700 transition-colors"
            >
              追加
            </button>
          </form>
        </details>
      </div>

      {/* Texts section */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">テキスト</h2>
        {asset.texts.length === 0 ? (
          <p className="text-sm text-slate-400 mb-3">テキストなし</p>
        ) : (
          <ul className="space-y-3 mb-4">
            {asset.texts.map((text) => (
                <li key={text.id} className="border border-slate-100 rounded p-3">
                  <div className="mb-1">
                    <span className="text-xs font-medium bg-teal-100 text-teal-700 px-2 py-0.5 rounded">
                      {TEXT_TYPE_LABELS[text.textType] ?? text.textType}
                    </span>
                  </div>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{text.content}</p>
                </li>
            ))}
          </ul>
        )}
        <details className="border border-slate-200 rounded p-3">
          <summary className="text-sm text-slate-600 cursor-pointer hover:text-slate-800">テキストを追加</summary>
          <form action={addAssetText.bind(null, id)} className="mt-3 space-y-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">テキストタイプ</label>
              <select
                name="textType"
                className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {Object.entries(TEXT_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">内容 <span className="text-red-500">*</span></label>
              <textarea
                name="content"
                rows={4}
                required
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              type="submit"
              className="bg-teal-600 text-white px-3 py-1 rounded text-sm hover:bg-teal-700 transition-colors"
            >
              追加
            </button>
          </form>
        </details>
      </div>

      {/* Source Records section */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">出典記録</h2>
        {asset.sourceRecords.length === 0 ? (
          <p className="text-sm text-slate-400 mb-3">出典記録なし</p>
        ) : (
          <ul className="space-y-3 mb-4">
            {asset.sourceRecords.map((src) => (
                <li key={src.id} className="border border-slate-100 rounded p-3 text-sm">
                  <div className="mb-1">
                    <span className="text-xs font-medium bg-orange-100 text-orange-700 px-2 py-0.5 rounded">
                      {SOURCE_KIND_LABELS[src.sourceKind] ?? src.sourceKind}
                    </span>
                  </div>
                  <p className="font-medium text-slate-800">{src.title || "(タイトルなし)"}</p>
                  {src.url && (
                    <a href={src.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline break-all">
                      {src.url}
                    </a>
                  )}
                  <div className="text-xs text-slate-400 mt-1 flex gap-3">
                    {src.publisher && <span>{src.publisher}</span>}
                    {src.publishedAt && <span>{formatDate(src.publishedAt, true)}</span>}
                  </div>
                </li>
            ))}
          </ul>
        )}
        <details className="border border-slate-200 rounded p-3">
          <summary className="text-sm text-slate-600 cursor-pointer hover:text-slate-800">出典を追加</summary>
          <form action={addSourceRecord.bind(null, id)} className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">種別</label>
                <select
                  name="sourceKind"
                  className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {Object.entries(SOURCE_KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs text-slate-500 mb-1">タイトル</label>
                <input
                  type="text"
                  name="sourceTitle"
                  className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">URL</label>
              <input
                type="url"
                name="sourceUrl"
                className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="https://..."
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="flex-1 min-w-[140px]">
                <label className="block text-xs text-slate-500 mb-1">発行者</label>
                <input
                  type="text"
                  name="publisher"
                  className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">発行日</label>
                <input
                  type="date"
                  name="publishedAt"
                  className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <button
              type="submit"
              className="bg-orange-600 text-white px-3 py-1 rounded text-sm hover:bg-orange-700 transition-colors"
            >
              追加
            </button>
          </form>
        </details>
      </div>

      {/* Annotations section */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">アノテーション</h2>
        {asset.annotations.length === 0 ? (
          <p className="text-sm text-slate-400 mb-3">アノテーションなし</p>
        ) : (
          <ul className="space-y-3 mb-4">
            {asset.annotations.map((ann) => (
                <li key={ann.id} className="border border-slate-100 rounded p-3 text-sm">
                  <div className="mb-1">
                    <span className="text-xs font-medium bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded">
                      {ANNOTATION_KIND_LABELS[ann.kind] ?? ann.kind}
                    </span>
                  </div>
                  <p className="text-slate-700 whitespace-pre-wrap">{ann.body}</p>
                </li>
            ))}
          </ul>
        )}
        <details className="border border-slate-200 rounded p-3">
          <summary className="text-sm text-slate-600 cursor-pointer hover:text-slate-800">アノテーションを追加</summary>
          <form action={addAnnotation.bind(null, id)} className="mt-3 space-y-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">種別</label>
              <select
                name="annotationKind"
                className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {Object.entries(ANNOTATION_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">内容 <span className="text-red-500">*</span></label>
              <textarea
                name="body"
                rows={3}
                required
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              type="submit"
              className="bg-indigo-600 text-white px-3 py-1 rounded text-sm hover:bg-indigo-700 transition-colors"
            >
              追加
            </button>
          </form>
        </details>
      </div>

      {/* Add to collection */}
      {collections.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">コレクションに追加</h2>
          <AddToCollectionForm assetId={id} collections={collections} />
        </div>
      )}
    </div>
  );
}
