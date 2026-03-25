import { search } from "@/lib/search";
import { prisma } from "@/lib/db";
import { ASSET_KIND_LABELS, ASSET_STATUS_LABELS, TRUST_LEVEL_LABELS, ENTITY_TYPE_LABELS } from "@/lib/utils";
import Link from "next/link";
import type { AssetKind, AssetStatus, TrustLevel } from "@prisma/client";


function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
      {ASSET_KIND_LABELS[kind] ?? kind}
    </span>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.round(score * 100));
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full bg-blue-400 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-400">{pct}</span>
    </div>
  );
}

const MATCH_FIELD_LABELS: Record<string, string> = {
  title: "タイトル",
  description: "説明",
  messageBodyPreview: "メッセージ",
  entity: "エンティティ",
  note: "メモ",
  body: "本文",
  ocr: "OCR",
  transcript: "文字起こし",
  extracted: "抽出テキスト",
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    target?: string;
    kind?: string;
    status?: string;
    trustLevel?: string;
    entityId?: string;
    dateFrom?: string;
    dateTo?: string;
    view?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const q = params.q ?? "";
  const target = (params.target as "all" | "assets" | "texts") || "all";
  const view = params.view === "gallery" ? "gallery" : "list";
  const page = Math.max(1, parseInt(params.page ?? "1"));

  const entities = await prisma.entity.findMany({
    orderBy: [{ type: "asc" }, { canonicalName: "asc" }],
  });

  let results = null;
  if (q.trim()) {
    results = await search({
      q,
      target,
      kind: params.kind as AssetKind | undefined,
      status: params.status as AssetStatus | undefined,
      trustLevel: params.trustLevel as TrustLevel | undefined,
      entityId: params.entityId || undefined,
      dateFrom: params.dateFrom ? new Date(params.dateFrom) : undefined,
      dateTo: params.dateTo ? new Date(params.dateTo) : undefined,
      page,
      perPage: 20,
    });
  }

  function buildUrl(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    const merged = { ...params, ...overrides };
    if (merged.q) p.set("q", merged.q);
    if (merged.target && merged.target !== "all") p.set("target", merged.target);
    if (merged.kind) p.set("kind", merged.kind);
    if (merged.status) p.set("status", merged.status);
    if (merged.trustLevel) p.set("trustLevel", merged.trustLevel);
    if (merged.entityId) p.set("entityId", merged.entityId);
    if (merged.dateFrom) p.set("dateFrom", merged.dateFrom);
    if (merged.dateTo) p.set("dateTo", merged.dateTo);
    if (merged.view && merged.view !== "list") p.set("view", merged.view);
    if (merged.page && merged.page !== "1") p.set("page", merged.page);
    return `/search?${p.toString()}`;
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">検索</h1>
      </div>

      {/* Search form */}
      <form method="GET" action="/search" className="bg-white border border-slate-200 rounded-lg p-4 mb-4 space-y-3">
        <div className="flex gap-3">
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="キーワードを入力..."
            className="flex-1 border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="bg-blue-600 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            検索
          </button>
        </div>

        {/* Target tabs */}
        <div className="flex gap-1">
          {(["all", "assets", "texts"] as const).map((t) => (
            <button
              key={t}
              type="submit"
              name="target"
              value={t}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                target === t
                  ? "bg-blue-600 text-white"
                  : "border border-slate-300 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {t === "all" ? "すべて" : t === "assets" ? "アセット" : "テキスト"}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-slate-500 mb-1">種別</label>
            <select
              name="kind"
              defaultValue={params.kind ?? ""}
              className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">すべて</option>
              {Object.entries(ASSET_KIND_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">ステータス</label>
            <select
              name="status"
              defaultValue={params.status ?? ""}
              className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">すべて</option>
              {Object.entries(ASSET_STATUS_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">信頼度</label>
            <select
              name="trustLevel"
              defaultValue={params.trustLevel ?? ""}
              className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">すべて</option>
              {Object.entries(TRUST_LEVEL_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">エンティティ</label>
            <select
              name="entityId"
              defaultValue={params.entityId ?? ""}
              className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">すべて</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {`[${ENTITY_TYPE_LABELS[e.type] ?? e.type}] ${e.canonicalName}`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">開始日</label>
            <input
              type="date"
              name="dateFrom"
              defaultValue={params.dateFrom ?? ""}
              className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">終了日</label>
            <input
              type="date"
              name="dateTo"
              defaultValue={params.dateTo ?? ""}
              className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </form>

      {results && (
        <>
          {/* View toggle + result count */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-slate-500">
              {results.total} 件
            </span>
            <div className="flex gap-1">
              <Link
                href={buildUrl({ view: "list", page: "1" })}
                className={`px-3 py-1 rounded text-sm border transition-colors ${
                  view === "list"
                    ? "bg-slate-700 text-white border-slate-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                リスト
              </Link>
              <Link
                href={buildUrl({ view: "gallery", page: "1" })}
                className={`px-3 py-1 rounded text-sm border transition-colors ${
                  view === "gallery"
                    ? "bg-slate-700 text-white border-slate-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                ギャラリー
              </Link>
            </div>
          </div>

          {results.items.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <p>「{q}」に一致するアセットが見つかりませんでした</p>
            </div>
          ) : view === "gallery" ? (
            /* Gallery view */
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {results.items.map((item, idx) => (
                <Link
                  key={`${item.assetId}-${idx}`}
                  href={`/assets/${item.assetId}`}
                  className="bg-white border border-slate-200 rounded-lg overflow-hidden hover:border-blue-400 transition-colors"
                >
                  {item.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.thumbnailUrl}
                      alt={item.assetTitle}
                      className="w-full h-32 object-cover"
                    />
                  ) : (item.assetKind === "image" || item.assetKind === "video") && item.storageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.storageUrl}
                      alt={item.assetTitle}
                      className="w-full h-32 object-cover"
                    />
                  ) : (
                    <div className="w-full h-32 bg-slate-100 flex items-center justify-center text-slate-400 text-xs">
                      {ASSET_KIND_LABELS[item.assetKind] ?? item.assetKind}
                    </div>
                  )}
                  <div className="p-2">
                    <p className="text-xs font-medium text-slate-800 line-clamp-2">{item.assetTitle}</p>
                    <div className="mt-1">
                      <KindBadge kind={item.assetKind} />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            /* List view */
            <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
              {results.items.map((item, idx) => (
                <Link
                  key={`${item.assetId}-${idx}`}
                  href={`/assets/${item.assetId}`}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 transition-colors"
                >
                  {/* Thumbnail */}
                  {(item.thumbnailUrl || ((item.assetKind === "image" || item.assetKind === "video") && item.storageUrl)) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.thumbnailUrl ?? item.storageUrl!}
                      alt=""
                      className="w-14 h-14 object-cover rounded shrink-0 bg-slate-100"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-slate-900">{item.assetTitle}</span>
                      <KindBadge kind={item.assetKind} />
                      <span className="text-xs text-slate-400">
                        {MATCH_FIELD_LABELS[item.matchField] ?? item.matchField}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1 line-clamp-2">{item.snippet}</p>
                  </div>
                  <div className="shrink-0">
                    <ScoreBar score={item.score} />
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* Pagination */}
          {results.total > results.perPage && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-sm text-slate-500">{page} ページ目</span>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link
                    href={buildUrl({ page: String(page - 1) })}
                    className="border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50"
                  >
                    ← 前へ
                  </Link>
                )}
                {results.items.length === results.perPage && (
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
        </>
      )}

      {!q.trim() && (
        <div className="text-center py-16 text-slate-400">
          <p>キーワードを入力して検索してください</p>
        </div>
      )}
    </div>
  );
}
