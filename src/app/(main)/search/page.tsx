import { Suspense } from "react";
import { search } from "@/lib/search";
import { getCachedEntities } from "@/lib/cache";
import { ASSET_KIND_LABELS } from "@/lib/utils";
import { SearchForm } from "./search-form";
import Link from "next/link";
import type { AssetKind, AssetStatus, TrustLevel, SourceType } from "@prisma/client";

type SearchMode = "all" | "text" | "media" | "image" | "live";

const MEDIA_SHOW_NAMES = [
  "日向坂で会いましょう",
  "日向坂になりましょう",
  "日向坂ちゃんねる",
  "日向坂46公式チャンネル",
  "雑誌",
];

interface ModePreset {
  sourceType?: SourceType;
  kind?: AssetKind;
  target?: "all" | "assets" | "texts";
  view?: "list" | "gallery";
  entityNames?: string[];
}

const MODE_PRESETS: Record<SearchMode, ModePreset> = {
  all: {},
  text: { kind: "text", target: "texts" },
  media: { entityNames: MEDIA_SHOW_NAMES },
  image: { kind: "image", view: "gallery" },
  live: { entityNames: ["ライブ"] },
};

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

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const parts: Array<{ text: string; highlight: boolean }> = [];
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(qLower, cursor);
    if (idx === -1) { parts.push({ text: text.slice(cursor), highlight: false }); break; }
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), highlight: false });
    parts.push({ text: text.slice(idx, idx + query.length), highlight: true });
    cursor = idx + query.length;
  }
  return <>{parts.map((p, i) => p.highlight ? <mark key={i} className="bg-yellow-200 text-yellow-900 rounded-sm px-0.5">{p.text}</mark> : <span key={i}>{p.text}</span>)}</>;
}

const MATCH_FIELD_LABELS: Record<string, string> = {
  title: "タイトル", description: "説明", messageBodyPreview: "メッセージ",
  entity: "エンティティ", note: "メモ", body: "本文",
  ocr: "OCR", transcript: "文字起こし", extracted: "抽出テキスト",
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const params = await searchParams;
  const q = params.q ?? "";
  const mode = (params.mode as SearchMode) || "all";
  const preset = MODE_PRESETS[mode] ?? {};
  const page = Math.max(1, parseInt(params.page ?? "1"));

  const effectiveTarget = (params.target as "all" | "assets" | "texts") || preset.target || "all";
  const effectiveKind = (params.kind as AssetKind | undefined) || preset.kind;
  const effectiveSourceType = (params.sourceType as SourceType | undefined) || preset.sourceType;
  const effectiveView = params.view ? (params.view as "list" | "gallery") : (preset.view ?? "list");

  const allEntities = await getCachedEntities();
  const entities = allEntities.map(({ _count, ...e }) => e);

  // Resolve preset entity IDs
  const presetEntityIds: string[] = [];
  if (preset.entityNames) {
    for (const name of preset.entityNames) {
      const found = entities.find((e) => e.canonicalName === name);
      if (found) presetEntityIds.push(found.id);
    }
  }

  const selectedEntityIds: string[] = params.entityIds
    ? params.entityIds.split(",").filter(Boolean)
    : [];
  const effectiveEntityIds = selectedEntityIds.length > 0 ? selectedEntityIds : presetEntityIds;

  const hasFilters = !!(effectiveKind || params.status || params.trustLevel || effectiveSourceType || params.dateFrom || params.dateTo || effectiveEntityIds.length > 0);

  let results = null;
  if (q.trim() || hasFilters) {
    results = await search({
      q, target: effectiveTarget, kind: effectiveKind,
      status: params.status as AssetStatus | undefined,
      trustLevel: params.trustLevel as TrustLevel | undefined,
      sourceType: effectiveSourceType,
      entityIds: effectiveEntityIds.length > 0 ? effectiveEntityIds : undefined,
      dateFrom: params.dateFrom ? new Date(params.dateFrom) : undefined,
      dateTo: params.dateTo ? new Date(params.dateTo) : undefined,
      page, perPage: 20,
    });
  }

  const mediaShowEntities = entities.filter((e) => MEDIA_SHOW_NAMES.includes(e.canonicalName));

  function buildUrl(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    const merged = { ...params, ...overrides };
    if (merged.q) p.set("q", merged.q);
    if (merged.mode && merged.mode !== "all") p.set("mode", merged.mode);
    if (merged.view) p.set("view", merged.view);
    if (merged.page && merged.page !== "1") p.set("page", merged.page);
    // Preserve current filters
    if (merged.sourceType) p.set("sourceType", merged.sourceType);
    if (merged.entityIds) p.set("entityIds", merged.entityIds);
    if (merged.kind) p.set("kind", merged.kind);
    if (merged.status) p.set("status", merged.status);
    if (merged.trustLevel) p.set("trustLevel", merged.trustLevel);
    if (merged.dateFrom) p.set("dateFrom", merged.dateFrom);
    if (merged.dateTo) p.set("dateTo", merged.dateTo);
    return `/search?${p.toString()}`;
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">検索</h1>
      </div>

      <Suspense>
        <SearchForm
          initialMode={mode}
          initialQ={q}
          initialSourceType={params.sourceType}
          initialEntityIds={selectedEntityIds}
          mediaShowEntities={mediaShowEntities}
          entities={entities}
        />
      </Suspense>

      {results && (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-slate-500">{results.total} 件</span>
            <div className="flex gap-1">
              <Link scroll={false} href={buildUrl({ view: "list", page: "1" })}
                className={`px-3 py-1 rounded text-sm border transition-colors ${effectiveView === "list" ? "bg-slate-700 text-white border-slate-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
                リスト
              </Link>
              <Link scroll={false} href={buildUrl({ view: "gallery", page: "1" })}
                className={`px-3 py-1 rounded text-sm border transition-colors ${effectiveView === "gallery" ? "bg-slate-700 text-white border-slate-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
                ギャラリー
              </Link>
            </div>
          </div>

          {results.items.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <p>{q ? `「${q}」に一致するアセットが見つかりませんでした` : "条件に一致するアセットが見つかりませんでした"}</p>
            </div>
          ) : effectiveView === "gallery" ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {results.items.map((item, idx) => (
                <Link key={`${item.assetId}-${idx}`} href={`/assets/${item.assetId}`}
                  className="bg-white border border-slate-200 rounded-lg overflow-hidden hover:border-blue-400 transition-colors">
                  {item.thumbnailUrl ? (
                    <img src={item.thumbnailUrl} alt={item.assetTitle} className="w-full h-32 object-cover" />
                  ) : (item.assetKind === "image" || item.assetKind === "video") && item.storageUrl ? (
                    <img src={item.storageUrl} alt={item.assetTitle} className="w-full h-32 object-cover" />
                  ) : (
                    <div className="w-full h-32 bg-slate-100 flex items-center justify-center text-slate-400 text-xs">
                      {ASSET_KIND_LABELS[item.assetKind] ?? item.assetKind}
                    </div>
                  )}
                  <div className="p-2">
                    <p className="text-xs font-medium text-slate-800 line-clamp-2">{item.assetTitle}</p>
                    <div className="mt-1"><KindBadge kind={item.assetKind} /></div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
              {results.items.map((item, idx) => (
                <Link key={`${item.assetId}-${idx}`} href={`/assets/${item.assetId}`}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
                  {(item.thumbnailUrl || ((item.assetKind === "image" || item.assetKind === "video") && item.storageUrl)) && (
                    <img src={item.thumbnailUrl ?? item.storageUrl!} alt="" className="w-14 h-14 object-cover rounded shrink-0 bg-slate-100" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-slate-900">{item.assetTitle}</span>
                      <KindBadge kind={item.assetKind} />
                      <span className="text-xs text-slate-400">{MATCH_FIELD_LABELS[item.matchField] ?? item.matchField}</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                      <HighlightedSnippet text={item.snippet} query={q} />
                    </p>
                  </div>
                  <div className="shrink-0"><ScoreBar score={item.score} /></div>
                </Link>
              ))}
            </div>
          )}

          {(page > 1 || results.items.length === results.perPage) && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-sm text-slate-500">{page} ページ目</span>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link scroll={false} href={buildUrl({ page: String(page - 1) })}
                    className="border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50">← 前へ</Link>
                )}
                {results.items.length === results.perPage && (
                  <Link scroll={false} href={buildUrl({ page: String(page + 1) })}
                    className="border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50">次へ →</Link>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {!results && (
        <div className="text-center py-16 text-slate-400">
          <p>キーワードを入力するか、モードを選択して検索してください</p>
        </div>
      )}
    </div>
  );
}
