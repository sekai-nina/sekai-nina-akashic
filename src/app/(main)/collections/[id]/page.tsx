import { prisma } from "@/lib/db";
import { removeFromCollection, deleteCollection, updateCollectionItem } from "@/lib/actions";
import { ASSET_KIND_LABELS, formatDate } from "@/lib/utils";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
      {ASSET_KIND_LABELS[kind] ?? kind}
    </span>
  );
}

function resolveImageUrl(asset: { thumbnailUrl: string | null; storageProvider: string; storageKey: string | null; storageUrl: string | null; kind: string }): string | null {
  if (asset.kind === "image" && asset.storageProvider === "gdrive" && asset.storageKey) {
    return `/api/drive-image/${asset.storageKey}`;
  }
  return asset.thumbnailUrl ?? (asset.kind === "image" ? asset.storageUrl : null);
}

export default async function CollectionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const collection = await prisma.collection.findUnique({
    where: { id },
    include: {
      items: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        include: {
          asset: true,
        },
      },
    },
  });

  if (!collection) notFound();

  const deleteCollectionAction = deleteCollection.bind(null, id);

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-slate-400 mb-2">
          <Link href="/collections" className="hover:text-slate-600">コレクション</Link>
          <span>/</span>
          <span className="text-slate-600 truncate">{collection.name}</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">{collection.name}</h1>
        {collection.description && (
          <p className="text-slate-500 text-sm mt-1">{collection.description}</p>
        )}
        <div className="flex items-center gap-3 mt-2">
          <span className="text-xs text-slate-400">
            {collection.items.length} 件 · 作成: {formatDate(collection.createdAt)}
          </span>
          <form action={deleteCollectionAction}>
            <SubmitButton className="text-xs text-red-400 hover:text-red-600">
              削除
            </SubmitButton>
          </form>
        </div>
      </div>

      {/* Items */}
      {collection.items.length === 0 ? (
        <div className="text-center py-16 text-slate-400 bg-white border border-slate-200 rounded-lg">
          <p>アセットがありません</p>
          <p className="text-sm mt-1">アセット詳細ページからコレクションに追加できます</p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {collection.items.map((item) => {
            const removeAction = removeFromCollection.bind(null, id, item.assetId);
            const updateNoteAction = updateCollectionItem.bind(null, item.id);
            const imageUrl = resolveImageUrl(item.asset);

            return (
              <div key={item.id} className="px-4 py-3 space-y-2">
                <div className="flex items-start gap-3">
                  {/* Thumbnail */}
                  {imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imageUrl}
                      alt=""
                      className="w-10 h-10 object-cover rounded shrink-0 bg-slate-100"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/assets/${item.assetId}`}
                      className="text-sm font-medium text-slate-900 hover:text-blue-700 truncate block"
                    >
                      {item.asset.title || "(無題)"}
                    </Link>
                    <div className="flex items-center gap-2 mt-0.5">
                      <KindBadge kind={item.asset.kind} />
                      <span className="text-xs text-slate-400">{formatDate(item.asset.createdAt)}</span>
                    </div>
                  </div>
                  <form action={removeAction} className="shrink-0">
                    <SubmitButton className="text-xs text-red-400 hover:text-red-600">
                      削除
                    </SubmitButton>
                  </form>
                </div>

                {/* Note form */}
                <form action={updateNoteAction} className="flex gap-2 items-center">
                  <input
                    type="text"
                    name="note"
                    defaultValue={item.note ?? ""}
                    placeholder="メモを追加..."
                    className="flex-1 border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <SubmitButton className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 border border-slate-200 rounded hover:bg-slate-50">
                    保存
                  </SubmitButton>
                </form>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
