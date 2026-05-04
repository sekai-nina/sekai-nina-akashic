"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ASSET_KIND_LABELS, ASSET_STATUS_LABELS, TRUST_LEVEL_LABELS, ENTITY_TYPE_LABELS } from "@/lib/utils";
import { EntityFilter } from "./entity-filter";

const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

type SearchMode = "all" | "text" | "media" | "image" | "live";

const SEARCH_MODES: { key: SearchMode; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "text", label: "テキスト" },
  { key: "media", label: "メディア" },
  { key: "image", label: "画像" },
  { key: "live", label: "ライブ" },
];

interface SearchFormProps {
  initialMode: SearchMode;
  initialQ: string;
  initialSourceType?: string;
  initialEntityIds: string[];
  mediaShowEntities: { id: string; canonicalName: string }[];
  entities: { id: string; canonicalName: string; type: string }[];
}

export function SearchForm({
  initialMode,
  initialQ,
  initialSourceType,
  initialEntityIds,
  mediaShowEntities,
  entities,
}: SearchFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [mode, setMode] = useState<SearchMode>(initialMode);
  const [sourceType, setSourceType] = useState<string | undefined>(initialSourceType);
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>(initialEntityIds);
  const [ninaOnly, setNinaOnly] = useState(initialEntityIds.includes(NINA_ENTITY_ID));

  const entityTypes = [...new Set(entities.map((e) => e.type))];
  const entitiesByType = Object.fromEntries(
    entityTypes.map((t) => [t, entities.filter((e) => e.type === t)])
  );

  function handleModeChange(newMode: SearchMode) {
    setMode(newMode);
    setSourceType(undefined);
    setSelectedEntityIds([]);
  }

  function toggleMediaEntity(id: string) {
    setSelectedEntityIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const p = new URLSearchParams();

    const q = formData.get("q") as string;
    if (q) p.set("q", q);
    if (mode !== "all") p.set("mode", mode);
    if (sourceType) p.set("sourceType", sourceType);

    // エンティティID: ninaOnlyトグル + モード別選択 + 詳細フィルタをマージ
    const entityIds = new Set(selectedEntityIds);
    if (ninaOnly) entityIds.add(NINA_ENTITY_ID);
    if (entityIds.size > 0) p.set("entityIds", [...entityIds].join(","));

    // Date filters
    const dateFrom = formData.get("dateFrom") as string;
    const dateTo = formData.get("dateTo") as string;
    if (dateFrom) p.set("dateFrom", dateFrom);
    if (dateTo) p.set("dateTo", dateTo);

    // Advanced filters
    const kind = formData.get("kind") as string;
    const status = formData.get("status") as string;
    const trustLevel = formData.get("trustLevel") as string;
    const target = formData.get("target") as string;
    const advEntityIds = formData.get("entityIds") as string;
    if (kind) p.set("kind", kind);
    if (status) p.set("status", status);
    if (trustLevel) p.set("trustLevel", trustLevel);
    if (target && target !== "all") p.set("target", target);
    // 詳細フィルタのエンティティIDをマージ
    if (advEntityIds) {
      const existing = p.get("entityIds");
      const merged = new Set([...(existing?.split(",") ?? []), ...advEntityIds.split(",")].filter(Boolean));
      p.set("entityIds", [...merged].join(","));
    }

    // Preserve view
    const view = searchParams.get("view");
    if (view) p.set("view", view);

    router.push(`/search?${p.toString()}`, { scroll: false });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 mb-4">
      <div className="flex gap-3">
        <input
          type="text"
          name="q"
          defaultValue={initialQ}
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

      {/* Mode chips + Nina toggle */}
      <div className="flex gap-1.5 flex-wrap items-center">
        {SEARCH_MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => handleModeChange(m.key)}
            className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
              mode === m.key
                ? "bg-blue-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {m.label}
          </button>
        ))}
        <span className="text-slate-300 mx-0.5">|</span>
        <button
          type="button"
          onClick={() => setNinaOnly(!ninaOnly)}
          className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
            ninaOnly
              ? "bg-purple-600 text-white"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          坂井新奈
        </button>
      </div>

      {/* Text mode: blog/talk sub-filter */}
      {mode === "text" && (
        <div className="flex gap-1 flex-wrap pl-1">
          {([
            { value: undefined as string | undefined, label: "すべて" },
            { value: "web", label: "ブログ" },
            { value: "import", label: "トーク" },
          ]).map((opt) => (
            <button
              key={opt.label}
              type="button"
              onClick={() => setSourceType(opt.value)}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                sourceType === opt.value
                  ? "bg-blue-100 text-blue-700"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* Media mode: show sub-filter */}
      {mode === "media" && mediaShowEntities.length > 0 && (
        <div className="flex gap-1 flex-wrap pl-1">
          {mediaShowEntities.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => toggleMediaEntity(e.id)}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                selectedEntityIds.includes(e.id)
                  ? "bg-blue-100 text-blue-700"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              }`}
            >
              {e.canonicalName}
            </button>
          ))}
        </div>
      )}

      {/* Date sub-filter */}
      {mode !== "all" && (
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-slate-500 mb-1">開始日</label>
            <input
              type="date"
              name="dateFrom"
              defaultValue={searchParams.get("dateFrom") ?? ""}
              className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">終了日</label>
            <input
              type="date"
              name="dateTo"
              defaultValue={searchParams.get("dateTo") ?? ""}
              className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      )}

      {/* Advanced filters */}
      {mode === "all" ? (
        <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs text-slate-500 mb-1">種別</label>
              <select
                name="kind"
                defaultValue={searchParams.get("kind") ?? ""}
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
                defaultValue={searchParams.get("status") ?? ""}
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
                defaultValue={searchParams.get("trustLevel") ?? ""}
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
            initialSelected={initialEntityIds}
          />
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs text-slate-500 mb-1">開始日</label>
              <input
                type="date"
                name="dateFrom"
                defaultValue={searchParams.get("dateFrom") ?? ""}
                className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">終了日</label>
              <input
                type="date"
                name="dateTo"
                defaultValue={searchParams.get("dateTo") ?? ""}
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
                  defaultValue={searchParams.get("kind") ?? ""}
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
                  defaultValue={searchParams.get("status") ?? ""}
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
                  defaultValue={searchParams.get("trustLevel") ?? ""}
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
              initialSelected={initialEntityIds}
            />
          </div>
        </details>
      )}
    </form>
  );
}
