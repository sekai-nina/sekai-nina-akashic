import { prisma } from "@/lib/db";
import { addEntityAlias, removeEntityAlias } from "@/lib/actions";
import { searchMentions } from "@/lib/domain/mentions";
import { ENTITY_TYPE_LABELS, ASSET_KIND_LABELS, formatDate } from "@/lib/utils";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";

const TEXT_TYPE_LABELS: Record<string, string> = {
  title: "タイトル",
  body: "本文",
  description: "説明",
  message_body: "メッセージ",
  ocr: "OCR",
  transcript: "文字起こし",
  note: "メモ",
  extracted: "抽出テキスト",
};

const typeColors: Record<string, string> = {
  person: "bg-purple-100 text-purple-800",
  place: "bg-green-100 text-green-800",
  source: "bg-orange-100 text-orange-800",
  event: "bg-blue-100 text-blue-800",
  tag: "bg-slate-100 text-slate-700",
};

export default async function EntityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ showMentions?: string }>;
}) {
  const { id } = await params;
  const { showMentions } = await searchParams;

  const entity = await prisma.entity.findUnique({
    where: { id },
    include: {
      _count: { select: { assets: true } },
    },
  });

  if (!entity) notFound();

  const aliases = (entity.aliases as string[]) || [];

  // Load linked assets
  const linkedAssets = await prisma.assetEntity.findMany({
    where: { entityId: id },
    include: {
      asset: {
        select: { id: true, title: true, kind: true, canonicalDate: true, createdAt: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  // Search mentions if requested
  const mentions = showMentions === "1" ? await searchMentions(id) : null;

  const addAliasAction = addEntityAlias.bind(null, id);
  const color = typeColors[entity.type] ?? "bg-slate-100 text-slate-700";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-sm text-slate-400 mb-2">
          <Link href="/entities" className="flex items-center gap-1 hover:text-slate-600">
            <ArrowLeft size={14} />
            エンティティ一覧
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">{entity.canonicalName}</h1>
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium ${color}`}>
            {ENTITY_TYPE_LABELS[entity.type] ?? entity.type}
          </span>
        </div>
        {entity.description && (
          <p className="text-sm text-slate-500 mt-1">{entity.description}</p>
        )}
        <p className="text-xs text-slate-400 mt-1">
          紐づきアセット: {entity._count.assets} 件
        </p>
      </div>

      {/* Aliases management */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">エイリアス（別名）</h2>
        {aliases.length === 0 ? (
          <p className="text-sm text-slate-400 mb-3">エイリアスなし</p>
        ) : (
          <div className="flex flex-wrap gap-2 mb-4">
            {aliases.map((alias) => {
              const removeAction = removeEntityAlias.bind(null, id, alias);
              return (
                <form key={alias} action={removeAction} className="inline-flex">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm bg-slate-100 text-slate-700">
                    {alias}
                    <button
                      type="submit"
                      className="text-slate-400 hover:text-red-500 transition-colors"
                      title="削除"
                    >
                      &times;
                    </button>
                  </span>
                </form>
              );
            })}
          </div>
        )}
        <form action={addAliasAction} className="flex gap-2">
          <input
            type="text"
            name="alias"
            required
            placeholder="別名を入力（例: にーな、Nina）"
            className="flex-1 border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="bg-slate-700 text-white px-3 py-1.5 rounded text-sm hover:bg-slate-800 transition-colors"
          >
            追加
          </button>
        </form>
      </div>

      {/* Linked assets */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-700">紐づきアセット</h2>
          <Link
            href={`/search?entityIds=${id}`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            検索で全件表示 →
          </Link>
        </div>
        {linkedAssets.length === 0 ? (
          <p className="text-sm text-slate-400">なし</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {linkedAssets.map((ae) => (
              <Link
                key={ae.asset.id}
                href={`/assets/${ae.asset.id}`}
                className="flex items-center gap-3 py-2 hover:bg-slate-50 transition-colors -mx-2 px-2 rounded"
              >
                <span className="flex-1 text-sm text-slate-900 truncate">
                  {ae.asset.title || "(無題)"}
                </span>
                <span className="shrink-0 text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                  {ASSET_KIND_LABELS[ae.asset.kind] ?? ae.asset.kind}
                </span>
                <span className="shrink-0 text-xs text-slate-400">
                  {formatDate(ae.asset.canonicalDate ?? ae.asset.createdAt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Mention search */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-700">言及検索</h2>
          <div className="flex gap-2">
            {mentions && (
              <a
                href={`/api/entities/${id}/mentions`}
                className="flex items-center gap-1 text-xs border border-slate-300 text-slate-600 px-2.5 py-1 rounded hover:bg-slate-50 transition-colors"
              >
                <Download size={12} />
                CSV
              </a>
            )}
            {showMentions !== "1" ? (
              <Link
                href={`/entities/${id}?showMentions=1`}
                className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 transition-colors"
              >
                言及を検索
              </Link>
            ) : (
              <Link
                href={`/entities/${id}`}
                className="text-xs border border-slate-300 text-slate-600 px-3 py-1 rounded hover:bg-slate-50 transition-colors"
              >
                閉じる
              </Link>
            )}
          </div>
        </div>
        <p className="text-xs text-slate-400 mb-3">
          正規名「{entity.canonicalName}」{aliases.length > 0 ? `＋エイリアス（${aliases.join("、")}）` : ""}をテキスト本文から横断検索します
        </p>

        {mentions && (
          <>
            <p className="text-sm text-slate-500 mb-3">{mentions.length} 件の言及</p>
            {mentions.length === 0 ? (
              <p className="text-sm text-slate-400">言及が見つかりませんでした</p>
            ) : (
              <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
                {mentions.map((m, i) => (
                  <Link
                    key={`${m.textId}-${i}`}
                    href={`/assets/${m.assetId}`}
                    className="block py-3 hover:bg-slate-50 transition-colors -mx-2 px-2 rounded"
                  >
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-sm font-medium text-slate-900">
                        {m.assetTitle || "(無題)"}
                      </span>
                      <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                        {ASSET_KIND_LABELS[m.assetKind] ?? m.assetKind}
                      </span>
                      <span className="text-xs bg-teal-100 text-teal-700 px-2 py-0.5 rounded">
                        {TEXT_TYPE_LABELS[m.textType] ?? m.textType}
                      </span>
                      <span className="text-xs text-blue-600">
                        「{m.matchedAlias}」
                      </span>
                      {m.canonicalDate && (
                        <span className="text-xs text-slate-400">
                          {formatDate(m.canonicalDate)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 line-clamp-2">{m.snippet}</p>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
