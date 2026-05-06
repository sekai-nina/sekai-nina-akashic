import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import {
  addEntityToAsset,
  addAssetText,
  addSourceRecord,
  addToCollection,
  addAssetRelation,
} from "@/lib/actions";
import {
  ASSET_KIND_LABELS,
  ASSET_STATUS_LABELS,
  TRUST_LEVEL_LABELS,
  ENTITY_TYPE_LABELS,
  RELATION_TYPE_LABELS,
  formatDate,
} from "@/lib/utils";
import { getAssetRelations, getAssetGraph } from "@/lib/domain/relations";
import { SubmitButton } from "@/components/submit-button";
import { BackButton } from "@/components/back-button";
import { StatusWorkflow } from "./status-workflow";
import { CopySourceRef } from "./copy-source-ref";
import { ParentAssets, ChildAssets } from "./related-assets";
import { SubGraph } from "./sub-graph";
import Link from "next/link";
import { notFound } from "next/navigation";


async function addToCollectionAction(assetId: string, formData: FormData) {
  "use server";
  const collectionId = formData.get("collectionId") as string;
  if (collectionId) await addToCollection(collectionId, assetId);
}

function RichTextContent({
  content,
  embeddedImages,
}: {
  content: string;
  embeddedImages: Record<string, { thumbnailUrl: string | null; title: string }>;
}) {
  const parts = content.split(/(\{\{IMG:[a-zA-Z0-9_-]+\}\})/);
  return (
    <div className="text-sm text-slate-700 whitespace-pre-wrap">
      {parts.map((part, i) => {
        const match = part.match(/^\{\{IMG:([a-zA-Z0-9_-]+)\}\}$/);
        if (match) {
          const assetId = match[1];
          const img = embeddedImages[assetId];
          if (img?.thumbnailUrl) {
            return (
              <Link key={i} href={`/assets/${assetId}`} className="block my-2">
                <img
                  src={img.thumbnailUrl}
                  alt={img.title || ""}
                  className="max-w-full rounded-lg border border-slate-200 hover:opacity-90 transition-opacity"
                  loading="lazy"
                />
              </Link>
            );
          }
          return null;
        }
        return <span key={i}>{part}</span>;
      })}
    </div>
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


export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();

  const [asset, collections, relations, graph] = await Promise.all([
    prisma.asset.findUnique({
      where: { id },
      include: {
        texts: { orderBy: { createdAt: "asc" } },
        entities: {
          include: { entity: true },
          orderBy: { createdAt: "asc" },
        },
        sourceRecords: { orderBy: { createdAt: "asc" } },
      },
    }),
    session?.user
      ? prisma.collection.findMany({
          where: { ownerId: session.user.id },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    getAssetRelations(id),
    getAssetGraph(id, 1),
  ]);

  if (!asset) notFound();

  let duplicates: { id: string; title: string }[] = [];
  if (asset.sha256) {
    duplicates = await prisma.asset.findMany({
      where: { sha256: asset.sha256, id: { not: id } },
      select: { id: true, title: true },
    });
  }

  const isImage = asset.kind === "image";
  let previewUrl = asset.thumbnailUrl;
  if (isImage && !previewUrl) {
    if (asset.storageProvider === "gdrive" && asset.storageKey) {
      previewUrl = `/api/drive-image/${asset.storageKey}`;
    } else {
      previewUrl = asset.storageUrl;
    }
  }

  const imgPlaceholderRegex = /\{\{IMG:([a-zA-Z0-9_-]+)\}\}/g;
  const embeddedImageIds = new Set<string>();
  for (const text of asset.texts) {
    for (const match of text.content.matchAll(imgPlaceholderRegex)) {
      if (!/^\d+$/.test(match[1])) {
        embeddedImageIds.add(match[1]);
      }
    }
  }
  const embeddedImages: Record<string, { thumbnailUrl: string | null; title: string }> = {};
  if (embeddedImageIds.size > 0) {
    const imageAssets = await prisma.asset.findMany({
      where: { id: { in: [...embeddedImageIds] } },
      select: { id: true, thumbnailUrl: true, title: true },
    });
    for (const img of imageAssets) {
      embeddedImages[img.id] = { thumbnailUrl: img.thumbnailUrl, title: img.title };
    }
  }

  const totalRelations = relations.asSource.length + relations.asTarget.length;

  return (
    <div className="max-w-6xl mx-auto">
      {/* ===== Header (full width) ===== */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2"><BackButton /></div>
          <h1 className="text-2xl font-bold text-slate-900">{asset.title || "(無題)"}</h1>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
              {ASSET_KIND_LABELS[asset.kind] ?? asset.kind}
            </span>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium ${{
              inbox: "bg-yellow-100 text-yellow-800",
              triaging: "bg-blue-100 text-blue-800",
              organized: "bg-green-100 text-green-800",
              archived: "bg-slate-100 text-slate-600",
            }[asset.status] ?? "bg-slate-100 text-slate-600"}`}>
              {ASSET_STATUS_LABELS[asset.status] ?? asset.status}
            </span>
            <span className="text-xs text-slate-400">登録: {formatDate(asset.createdAt)}</span>
            {asset.canonicalDate && (
              <span className="text-xs text-slate-400">日付: {formatDate(asset.canonicalDate)}</span>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <CopySourceRef
            assetId={asset.id}
            title={asset.title || "(無題)"}
            canonicalDate={asset.canonicalDate?.toISOString() ?? null}
          />
          <Link
            href={`/assets/${id}/edit`}
            className="border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50 transition-colors"
          >
            編集
          </Link>
        </div>
      </div>

      {/* Duplicate warning */}
      {duplicates.length > 0 && (
        <div className="mt-4 bg-yellow-50 border border-yellow-300 rounded-lg p-3 text-sm text-yellow-800">
          <strong>重複の可能性:</strong> 同じファイルが他のアセットにも存在します。
          {duplicates.map((d) => (
            <span key={d.id}>{" "}
              <Link href={`/assets/${d.id}`} className="underline hover:text-yellow-900">{d.title || "(無題)"}</Link>
            </span>
          ))}
        </div>
      )}

      {/* ===== Two-column body ===== */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* === Left column (2/3) === */}
        <div className="lg:col-span-2 space-y-6">

          {/* Hero image preview */}
          {previewUrl && (
            <div className="relative bg-slate-50 border border-slate-200 rounded-xl p-6 flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt={asset.title || "プレビュー"}
                className="max-h-[560px] max-w-full object-contain rounded-lg"
              />
              {asset.storageUrl && (
                <a
                  href={asset.storageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="absolute bottom-3 right-3 text-xs bg-white/80 backdrop-blur text-slate-600 px-2.5 py-1 rounded-md hover:bg-white transition-colors border border-slate-200"
                >
                  オリジナルを開く →
                </a>
              )}
            </div>
          )}

          {/* Texts */}
          {asset.texts.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg p-5">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">テキスト</h2>
              <ul className="space-y-3 mb-4">
                {asset.texts.map((text) => (
                  <li key={text.id} className="border border-slate-100 rounded-lg p-3">
                    <div className="mb-1.5">
                      <span className="text-xs font-medium bg-teal-100 text-teal-700 px-2 py-0.5 rounded">
                        {TEXT_TYPE_LABELS[text.textType] ?? text.textType}
                      </span>
                    </div>
                    <RichTextContent content={text.content} embeddedImages={embeddedImages} />
                  </li>
                ))}
              </ul>
              <details className="border border-slate-200 rounded p-3">
                <summary className="text-sm text-slate-600 cursor-pointer hover:text-slate-800">テキストを追加</summary>
                <form action={addAssetText.bind(null, id)} className="mt-3 space-y-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">テキストタイプ</label>
                    <select name="textType" className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {Object.entries(TEXT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">内容 <span className="text-red-500">*</span></label>
                    <textarea name="content" rows={4} required className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <SubmitButton className="bg-teal-600 text-white px-3 py-1 rounded text-sm hover:bg-teal-700 transition-colors">追加</SubmitButton>
                </form>
              </details>
            </div>
          )}

          {/* Relations + Graph */}
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
              リレーション
              {totalRelations > 0 && <span className="text-slate-400 font-normal ml-1 normal-case">({totalRelations})</span>}
            </h2>

            {/* Parent assets (inline) */}
            {relations.asTarget.length > 0 && (
              <div className="mb-4">
                <p className="text-xs text-slate-400 mb-2">親アセット</p>
                <ParentAssets
                  relations={relations.asTarget.map((r) => ({
                    id: r.id, relationType: r.relationType, sortOrder: r.sortOrder, asset: r.source,
                  }))}
                  currentAssetId={id}
                  embedded
                />
              </div>
            )}

            {/* Child assets (inline) */}
            {relations.asSource.length > 0 && (
              <div className="mb-4">
                <p className="text-xs text-slate-400 mb-2">子・関連アセット</p>
                <ChildAssets
                  relations={relations.asSource.map((r) => ({
                    id: r.id, relationType: r.relationType, sortOrder: r.sortOrder, asset: r.target,
                  }))}
                  currentAssetId={id}
                  embedded
                />
              </div>
            )}

            {totalRelations === 0 && (
              <p className="text-sm text-slate-400 mb-3">リレーションなし</p>
            )}

            {/* Subgraph */}
            {graph.nodes.length > 1 && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <SubGraph
                  nodes={graph.nodes.map((n) => ({
                    id: n.id, label: n.title, kind: n.kind, thumbnailUrl: n.thumbnailUrl, isCurrent: n.id === id,
                  }))}
                  edges={graph.edges.map((e) => ({ from: e.source, to: e.target, relationType: e.relationType }))}
                />
                <div className="mt-2 text-right">
                  <Link href="/graph" className="text-xs text-blue-600 hover:text-blue-800 hover:underline">全体グラフで見る →</Link>
                </div>
              </div>
            )}

            <details className="border border-slate-200 rounded p-3 mt-3">
              <summary className="text-sm text-slate-600 cursor-pointer hover:text-slate-800">リレーションを追加</summary>
              <form action={addAssetRelation.bind(null, id)} className="mt-3 flex flex-wrap gap-3 items-end">
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-xs text-slate-500 mb-1">対象アセットID <span className="text-red-500">*</span></label>
                  <input type="text" name="targetId" required className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" placeholder="cuid..." />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">種別</label>
                  <select name="relationType" className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {Object.entries(RELATION_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <SubmitButton className="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700 transition-colors">追加</SubmitButton>
              </form>
            </details>
          </div>

          {/* Source Records */}
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">出典記録</h2>
            {asset.sourceRecords.length === 0 ? (
              <p className="text-sm text-slate-400 mb-3">出典記録なし</p>
            ) : (
              <ul className="space-y-3 mb-4">
                {asset.sourceRecords.map((src) => (
                  <li key={src.id} className="border border-slate-100 rounded-lg p-3 text-sm">
                    <div className="mb-1">
                      <span className="text-xs font-medium bg-orange-100 text-orange-700 px-2 py-0.5 rounded">
                        {SOURCE_KIND_LABELS[src.sourceKind] ?? src.sourceKind}
                      </span>
                    </div>
                    <p className="font-medium text-slate-800">{src.title || "(タイトルなし)"}</p>
                    {src.url && (
                      <a href={src.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline break-all">{src.url}</a>
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
                    <select name="sourceKind" className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {Object.entries(SOURCE_KIND_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div className="flex-1 min-w-[200px]">
                    <label className="block text-xs text-slate-500 mb-1">タイトル</label>
                    <input type="text" name="sourceTitle" className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">URL</label>
                  <input type="url" name="sourceUrl" className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="https://..." />
                </div>
                <div className="flex flex-wrap gap-3">
                  <div className="flex-1 min-w-[140px]">
                    <label className="block text-xs text-slate-500 mb-1">発行者</label>
                    <input type="text" name="publisher" className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">発行日</label>
                    <input type="date" name="publishedAt" className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>
                <SubmitButton className="bg-orange-600 text-white px-3 py-1 rounded text-sm hover:bg-orange-700 transition-colors">追加</SubmitButton>
              </form>
            </details>
          </div>

          {/* Add text form (when no texts exist) */}
          {asset.texts.length === 0 && (
            <div className="bg-white border border-slate-200 rounded-lg p-5">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">テキスト</h2>
              <p className="text-sm text-slate-400 mb-3">テキストなし</p>
              <details className="border border-slate-200 rounded p-3">
                <summary className="text-sm text-slate-600 cursor-pointer hover:text-slate-800">テキストを追加</summary>
                <form action={addAssetText.bind(null, id)} className="mt-3 space-y-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">テキストタイプ</label>
                    <select name="textType" className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {Object.entries(TEXT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">内容 <span className="text-red-500">*</span></label>
                    <textarea name="content" rows={4} required className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <SubmitButton className="bg-teal-600 text-white px-3 py-1 rounded text-sm hover:bg-teal-700 transition-colors">追加</SubmitButton>
                </form>
              </details>
            </div>
          )}
        </div>

        {/* === Right column (sidebar 1/3) === */}
        <div className="space-y-5">

          {/* Status */}
          <StatusWorkflow assetId={id} initialStatus={asset.status} />

          {/* Metadata */}
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">メタデータ</h2>
            <dl className="space-y-2.5 text-sm">
              <div>
                <dt className="text-xs text-slate-400">信頼度</dt>
                <dd className="text-slate-800 font-medium">{TRUST_LEVEL_LABELS[asset.trustLevel] ?? asset.trustLevel}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-400">ソース種別</dt>
                <dd className="text-slate-800">{asset.sourceType}</dd>
              </div>
              {asset.storageProvider && asset.storageProvider !== "local_none" && (
                <div>
                  <dt className="text-xs text-slate-400">プロバイダー</dt>
                  <dd className="text-slate-800">{asset.storageProvider}</dd>
                </div>
              )}
              {asset.originalFilename && (
                <div>
                  <dt className="text-xs text-slate-400">ファイル名</dt>
                  <dd className="text-slate-800 truncate">{asset.originalFilename}</dd>
                </div>
              )}
              {asset.mimeType && (
                <div>
                  <dt className="text-xs text-slate-400">MIMEタイプ</dt>
                  <dd className="text-slate-800">{asset.mimeType}</dd>
                </div>
              )}
              {asset.fileSize != null && (
                <div>
                  <dt className="text-xs text-slate-400">サイズ</dt>
                  <dd className="text-slate-800">{asset.fileSize.toLocaleString()} bytes</dd>
                </div>
              )}
              {asset.sha256 && (
                <div>
                  <dt className="text-xs text-slate-400">SHA256</dt>
                  <dd className="text-slate-800 font-mono text-[10px] break-all leading-relaxed">{asset.sha256}</dd>
                </div>
              )}
            </dl>
            {asset.description && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <p className="text-xs text-slate-400 mb-1">説明</p>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{asset.description}</p>
              </div>
            )}
            {!isImage && asset.storageUrl && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <a href={asset.storageUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:text-blue-800 underline break-all">
                  ファイルを開く →
                </a>
              </div>
            )}
          </div>

          {/* Entities */}
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">エンティティ</h2>
            {asset.entities.length === 0 ? (
              <p className="text-sm text-slate-400 mb-3">エンティティなし</p>
            ) : (
              <ul className="space-y-2 mb-3">
                {asset.entities.map((ae) => (
                  <li key={ae.entityId} className="flex items-center gap-2 text-sm">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800">
                      {ENTITY_TYPE_LABELS[ae.entity.type] ?? ae.entity.type}
                    </span>
                    <span className="text-slate-800 font-medium text-xs">{ae.entity.canonicalName}</span>
                    {ae.roleLabel && <span className="text-slate-400 text-[10px]">({ae.roleLabel})</span>}
                  </li>
                ))}
              </ul>
            )}
            <details className="border border-slate-200 rounded p-2.5">
              <summary className="text-xs text-slate-600 cursor-pointer hover:text-slate-800">エンティティを追加</summary>
              <form action={addEntityToAsset.bind(null, id)} className="mt-2 space-y-2">
                <div className="flex gap-2">
                  <select name="entityType" className="border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {Object.entries(ENTITY_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <input type="text" name="canonicalName" required className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="正規名" />
                </div>
                <div className="flex gap-2 items-center">
                  <input type="text" name="roleLabel" className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="役割ラベル" />
                  <SubmitButton className="bg-purple-600 text-white px-2.5 py-1 rounded text-xs hover:bg-purple-700 transition-colors">追加</SubmitButton>
                </div>
              </form>
            </details>
          </div>

          {/* Add to collection */}
          {collections.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">コレクション</h2>
              <form action={addToCollectionAction.bind(null, id)} className="flex gap-2">
                <select name="collectionId" className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {collections.map((col) => <option key={col.id} value={col.id}>{col.name}</option>)}
                </select>
                <SubmitButton className="bg-slate-700 text-white px-2.5 py-1.5 rounded text-xs hover:bg-slate-800 transition-colors">追加</SubmitButton>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
