import { search } from "@/lib/search";
import { prisma } from "@/lib/db";
import { ASSET_KIND_LABELS, ASSET_STATUS_LABELS, TRUST_LEVEL_LABELS, ENTITY_TYPE_LABELS } from "@/lib/utils";
import { EntityFilter } from "./entity-filter";
import Link from "next/link";
import type { AssetKind, AssetStatus, TrustLevel, SourceType } from "@prisma/client";


// Search modes with preset filters
type SearchMode = "all" | "text" | "media" | "image" | "live";

const SEARCH_MODES: { key: SearchMode; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "text", label: "テキスト" },
  { key: "media", label: "メディア" },
  { key: "image", label: "画像" },
  { key: "live", label: "ライブ" },
];

// Media show tag names for entity lookup
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
  entityNames?: string[]; // tag entity names to auto-select
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
    if (idx === -1) {
      parts.push({ text: text.slice(cursor), highlight: false });
      break;
    }
    if (idx > cursor) {
      parts.push({ text: text.slice(cursor, idx), highlight: false });
    }
    parts.push({ text: text.slice(idx, idx + query.length), highlight: true });
    cursor = idx + query.length;
  }
  return (
    <>
      {parts.map((p, i) =>
        p.highlight ? (
          <mark key={i} className="bg-yellow-200 text-yellow-900 rounded-sm px-0.5">{p.text}</mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
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
    mode?: string;
    target?: string;
    kind?: string;
    status?: string;
    trustLevel?: string;
    sourceType?: string;
    entityId?: string;
    [key: string]: string | undefined;
  }>;
}) {
  const params = await searchParams;
  const q = params.q ?? "";
  const mode = (params.mode as SearchMode) || "all";
  const preset = MODE_PRESETS[mode] ?? {};
  const page = Math.max(1, parseInt(params.page ?? "1"));

  // Apply mode presets, allow URL params to override
  const effectiveTarget = (params.target as "all" | "assets" | "texts") || preset.target || "all";
  const effectiveKind = (params.kind as AssetKind | undefined) || preset.kind;
  const effectiveSourceType = (params.sourceType as SourceType | undefined) || preset.sourceType;
  const effectiveView = params.view ? (params.view as "list" | "gallery") : (preset.view ?? "list");

  // Load entities for filter and mode-based entity resolution
  const entities = await prisma.entity.findMany({
    orderBy: [{ type: "asc" }, { canonicalName: "asc" }],
  });

  const entityTypes = [...new Set(entities.map((e) => e.type))];
  const entitiesByType = Object.fromEntries(
    entityTypes.map((t) => [t, entities.filter((e) => e.type === t)])
  );

  // Resolve entity IDs from mode preset (by entity name)
  const presetEntityIds: string[] = [];
  if (preset.entityNames) {
    for (const name of preset.entityNames) {
      const found = entities.find((e) => e.canonicalName === name);
      if (found) presetEntityIds.push(found.id);
    }
  }

  // Collect selected entity IDs from URL params
  const selectedEntityIds: string[] = params.entityIds
    ? params.entityIds.split(",").filter(Boolean)
    : [];
  if (params.entityId) selectedEntityIds.push(params.entityId);
  for (const t of entityTypes) {
    const val = params[`entity_${t}`];
    if (val) selectedEntityIds.push(val);
  }

  // For media/live modes, if no manual entity selection, use preset entities
  const effectiveEntityIds = selectedEntityIds.length > 0
    ? selectedEntityIds
    : presetEntityIds;

  // Execute search if keyword or filters present
  const hasFilters = !!(
    effectiveKind || params.status || params.trustLevel ||
    effectiveSourceType ||
    params.dateFrom || params.dateTo || effectiveEntityIds.length > 0
  );

  let results = null;
  if (q.trim() || hasFilters) {
    results = await search({
      q,
      target: effectiveTarget,
      kind: effectiveKind,
      status: params.status as AssetStatus | undefined,
      trustLevel: params.trustLevel as TrustLevel | undefined,
      sourceType: effectiveSourceType,
      entityIds: effectiveEntityIds.length > 0 ? effectiveEntityIds : undefined,
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
    if (merged.mode && merged.mode !== "all") p.set("mode", merged.mode);
    if (merged.target && merged.target !== "all") p.set("target", merged.target);
    if (merged.kind) p.set("kind", merged.kind);
    if (merged.status) p.set("status", merged.status);
    if (merged.trustLevel) p.set("trustLevel", merged.trustLevel);
    if (merged.sourceType) p.set("sourceType", merged.sourceType);
    if (merged.entityIds) p.set("entityIds", merged.entityIds);
    if (merged.dateFrom) p.set("dateFrom", merged.dateFrom);
    if (merged.dateTo) p.set("dateTo", merged.dateTo);
    if (merged.view) p.set("view", merged.view);
    if (merged.page && merged.page !== "1") p.set("page", merged.page);
    return `/search?${p.toString()}`;
  }

  // For media mode: resolve which media show entities exist
  const mediaShowEntities = mode === "media"
    ? entities.filter((e) => MEDIA_SHOW_NAMES.includes(e.canonicalName))
    : [];

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">検索</h1>
      </div>

      {/* Search bar */}
      <form method="GET" action="/search" className="space-y-3 mb-4">
        <input type="hidden" name="mode" value={mode} />
        <div className="flex gap-3">
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="キーワードを入力..."
            className="flex-1 border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          />
          <button
            type="submit"
            className="bg-blue-600 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            検索
          </button>
        </div>

        {/* Mode chips */}
        <div className="flex gap-1.5 flex-wrap">
          {SEARCH_MODES.map((m) => (
            <Link
              key={m.key}
              scroll={false}
              href={buildUrl({ mode: m.key === "all" ? undefined : m.key, page: "1", kind: undefined, status: undefined, trustLevel: undefined, sourceType: undefined, entityIds: undefined, target: undefined, view: undefined })}
              className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                mode === m.key
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {m.label}
            </Link>
          ))}
        </div>

        {/* Text mode: blog/talk sub-filter */}
        {mode === "text" && (
          <div className="flex gap-1 flex-wrap pl-1">
            {([
              { value: undefined, label: "すべて" },
              { value: "web" as const, label: "ブログ" },
              { value: "import" as const, label: "トーク" },
            ] as const).map((opt) => {
              const isActive = effectiveSourceType === opt.value;
              return (
                <Link
                  key={opt.label}
                  scroll={false}
                  href={buildUrl({ sourceType: opt.value, page: "1" })}
                  className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                    isActive
                      ? "bg-blue-100 text-blue-700"
                      : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  }`}
                >
                  {opt.label}
                </Link>
              );
            })}
          </div>
        )}

        {/* Media mode: show sub-filter */}
        {mode === "media" && mediaShowEntities.length > 0 && (
          <div className="flex gap-1 flex-wrap pl-1">
            {mediaShowEntities.map((e) => {
              const isActive = effectiveEntityIds.includes(e.id);
              const newIds = isActive
                ? effectiveEntityIds.filter((id) => id !== e.id)
                : [...effectiveEntityIds, e.id];
              return (
                <Link
                  key={e.id}
                  scroll={false}
                  href={buildUrl({ entityIds: newIds.join(",") || undefined, page: "1" })}
                  className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                    isActive
                      ? "bg-blue-100 text-blue-700"
                      : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  }`}
                >
                  {e.canonicalName}
                </Link>
              );
            })}
          </div>
        )}

        {/* Date sub-filter (for modes that use it) */}
        {mode !== "all" && (
          <div className="flex flex-wrap gap-3 items-end">
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
        )}

        {/* Advanced filters (collapsed, or always shown in "all" mode) */}
        {mode === "all" ? (
          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
            {/* Target tabs */}
            <div className="flex gap-1">
              {(["all", "assets", "texts"] as const).map((t) => (
                <button
                  key={t}
                  type="submit"
                  name="target"
                  value={t}
                  className={`px-3 py-1 rounded text-sm transition-colors ${
                    effectiveTarget === t
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
            </div>

            {/* Entity filters */}
            <EntityFilter
              entityTypes={entityTypes}
              entitiesByType={entitiesByType}
              typeLabels={ENTITY_TYPE_LABELS}
              initialSelected={selectedEntityIds}
            />

            {/* Date filters */}
            <div className="flex flex-wrap gap-3 items-end">
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
          </div>
        ) : (
          <details className="bg-white border border-slate-200 rounded-lg">
            <summary className="px-4 py-2.5 text-sm text-slate-500 cursor-pointer hover:text-slate-700">
              詳細フィルタ
            </summary>
            <div className="px-4 pb-4 pt-1 space-y-3">
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
              </div>
              <EntityFilter
                entityTypes={entityTypes}
                entitiesByType={entitiesByType}
                typeLabels={ENTITY_TYPE_LABELS}
                initialSelected={selectedEntityIds}
              />
            </div>
          </details>
        )}
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
                scroll={false}
                href={buildUrl({ view: "list", page: "1" })}
                className={`px-3 py-1 rounded text-sm border transition-colors ${
                  effectiveView === "list"
                    ? "bg-slate-700 text-white border-slate-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                リスト
              </Link>
              <Link
                scroll={false}
                href={buildUrl({ view: "gallery", page: "1" })}
                className={`px-3 py-1 rounded text-sm border transition-colors ${
                  effectiveView === "gallery"
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
              <p>{q ? `「${q}」に一致するアセットが見つかりませんでした` : "条件に一致するアセットが見つかりませんでした"}</p>
            </div>
          ) : effectiveView === "gallery" ? (
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
                    <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                      <HighlightedSnippet text={item.snippet} query={q} />
                    </p>
                  </div>
                  <div className="shrink-0">
                    <ScoreBar score={item.score} />
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* Pagination */}
          {(page > 1 || results.items.length === results.perPage) && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-sm text-slate-500">{page} ページ目</span>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link
                    scroll={false}
                    href={buildUrl({ page: String(page - 1) })}
                    className="border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50"
                  >
                    ← 前へ
                  </Link>
                )}
                {results.items.length === results.perPage && (
                  <Link
                    scroll={false}
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

      {!results && (
        <div className="text-center py-16 text-slate-400">
          <p>キーワードを入力するか、モードを選択して検索してください</p>
        </div>
      )}
    </div>
  );
}
