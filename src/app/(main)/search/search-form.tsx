"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { ASSET_KIND_LABELS, ENTITY_TYPE_LABELS } from "@/lib/utils";
import { EntityFilter } from "./entity-filter";
import { AuthorFilter } from "./author-filter";
import { CARRIED_PARAM_KEYS } from "./params";

const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

// チップの並び順（よく使う種別を先頭に）
const KIND_CHIPS = ["text", "image", "video", "audio", "document", "other"] as const;

// テキスト種別のサブフィルタ用タグ名
const TEXT_SUB_TAGS = ["ブログ", "トーク"];

interface SearchFormProps {
  initialQ: string;
  initialKinds: string[];
  initialEntityIds: string[];
  initialAuthorIds: string[];
  entities: { id: string; canonicalName: string; type: string }[];
}

export function SearchForm({
  initialQ,
  initialKinds,
  initialEntityIds,
  initialAuthorIds,
  entities,
}: SearchFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [kinds, setKinds] = useState<Set<string>>(new Set(initialKinds));
  const [ninaOnly, setNinaOnly] = useState(initialAuthorIds.includes(NINA_ENTITY_ID));
  const [searching, setSearching] = useState(false);

  const [filterEntityIds, setFilterEntityIds] = useState<Set<string>>(
    new Set(initialEntityIds)
  );
  const [filterAuthorIds, setFilterAuthorIds] = useState<Set<string>>(
    new Set(initialAuthorIds)
  );
  const qInputRef = useRef<HTMLInputElement>(null);
  const dateFromRef = useRef<HTMLInputElement>(null);
  const dateToRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSearching(false);
  }, [searchParams]);

  // Persist the current search URL so navigating away and back restores filters.
  const STORAGE_KEY = "search-last-query";
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    // Hydrate only when the user lands on /search with no params at all.
    if (searchParams.toString().length > 0) return;
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && saved.startsWith("?")) {
      router.replace(`/search${saved}`, { scroll: false });
    }
    // We deliberately ignore router/searchParams updates after the first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save the latest URL whenever the params change (so submissions are remembered).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const qs = searchParams.toString();
    if (qs.length > 0) {
      window.localStorage.setItem(STORAGE_KEY, `?${qs}`);
    }
  }, [searchParams]);

  const handleReset = useCallback(() => {
    setKinds(new Set());
    setNinaOnly(false);
    setFilterEntityIds(new Set());
    setFilterAuthorIds(new Set());
    // 日付は非制御 input なので、明示的に消さないと次の検索に持ち越される
    for (const ref of [qInputRef, dateFromRef, dateToRef]) {
      if (ref.current) ref.current.value = "";
    }
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    router.push("/search", { scroll: false });
  }, [router]);

  const HIDDEN_ENTITY_TYPES = new Set(["source"]);
  const entityTypes = [...new Set(entities.map((e) => e.type))].filter((t) => !HIDDEN_ENTITY_TYPES.has(t));
  const entitiesByType = Object.fromEntries(
    entityTypes.map((t) => [t, entities.filter((e) => e.type === t)])
  );

  // テキスト種別のサブフィルタ用エンティティ
  const textSubEntities = TEXT_SUB_TAGS
    .map((name) => entities.find((e) => e.canonicalName === name && e.type === "tag"))
    .filter((e): e is NonNullable<typeof e> => e != null);

  const toggleKind = useCallback((kind: string) => {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const handleNinaToggle = useCallback(() => {
    setNinaOnly((prev) => {
      const next = !prev;
      setFilterAuthorIds((ids) => {
        const updated = new Set(ids);
        if (next) updated.add(NINA_ENTITY_ID);
        else updated.delete(NINA_ENTITY_ID);
        return updated;
      });
      return next;
    });
  }, []);

  const handleTextSubFilter = useCallback((entityId: string) => {
    setFilterEntityIds((prev) => {
      const next = new Set(prev);
      // 他のテキストサブフィルタを外す（排他選択）
      for (const e of textSubEntities) {
        next.delete(e.id);
      }
      // 同じものをクリックした場合はトグルオフ（すべて）
      if (!prev.has(entityId)) {
        next.add(entityId);
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textSubEntities.map((e) => e.id).join(",")]);

  const toggleFilterAuthor = useCallback((id: string) => {
    if (id === NINA_ENTITY_ID) {
      setNinaOnly((prev) => !prev);
    }
    setFilterAuthorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleFilterEntity = useCallback((id: string) => {
    setFilterEntityIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSearching(true);
    const formData = new FormData(e.currentTarget);
    const p = new URLSearchParams();

    const q = formData.get("q") as string;
    if (q) p.set("q", q);
    // チップ順に正規化して、同じ選択なら常に同じ URL になるようにする
    const orderedKinds = KIND_CHIPS.filter((k) => kinds.has(k));
    if (orderedKinds.length > 0) p.set("kind", orderedKinds.join(","));

    if (filterEntityIds.size > 0) {
      p.set("entityIds", [...filterEntityIds].join(","));
    }
    if (filterAuthorIds.size > 0) {
      p.set("authorIds", [...filterAuthorIds].join(","));
    }

    const dateFrom = formData.get("dateFrom") as string;
    const dateTo = formData.get("dateTo") as string;
    if (dateFrom) p.set("dateFrom", dateFrom);
    if (dateTo) p.set("dateTo", dateTo);

    // フォームに UI が無いパラメータ（表示形式・テキスト分析からの絞り込み）は引き継ぐ
    for (const key of CARRIED_PARAM_KEYS) {
      const value = searchParams.get(key);
      if (value) p.set(key, value);
    }

    router.push(`/search?${p.toString()}`, { scroll: false });
  }

  // テキスト種別で選択中のサブフィルタ
  const activeTextSub = textSubEntities.find((e) => filterEntityIds.has(e.id));

  return (
    <form onSubmit={handleSubmit} className="space-y-3 mb-4">
      {/* Search bar */}
      <div className="flex gap-3">
        <input
          ref={qInputRef}
          type="text"
          name="q"
          defaultValue={initialQ}
          placeholder="キーワードを入力..."
          className="flex-1 border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        />
        <button
          type="submit"
          disabled={searching}
          className="bg-blue-600 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {searching ? <><Loader2 size={14} className="animate-spin" />検索中</> : "検索"}
        </button>
      </div>

      {/* 種別チップ（複数選択・OR）+ 坂井新奈トグル */}
      <div className="flex gap-1.5 flex-wrap items-center">
        <button
          type="button"
          onClick={() => setKinds(new Set())}
          className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
            kinds.size === 0
              ? "bg-blue-600 text-white"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          すべて
        </button>
        {KIND_CHIPS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => toggleKind(k)}
            className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
              kinds.has(k)
                ? "bg-blue-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {ASSET_KIND_LABELS[k]}
          </button>
        ))}
        <span className="text-slate-300 mx-0.5">|</span>
        <button
          type="button"
          onClick={handleNinaToggle}
          className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
            ninaOnly
              ? "bg-purple-600 text-white"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          坂井新奈
        </button>
        <button
          type="button"
          onClick={handleReset}
          title="検索条件をリセット"
          className="ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <RotateCcw size={12} />
          リセット
        </button>
      </div>

      {/* テキスト種別: ブログ/トークのサブフィルタ */}
      {kinds.has("text") && textSubEntities.length > 0 && (
        <div className="flex gap-1 flex-wrap pl-1">
          <button
            type="button"
            onClick={() => {
              setFilterEntityIds((prev) => {
                const next = new Set(prev);
                for (const e of textSubEntities) next.delete(e.id);
                return next;
              });
            }}
            className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
              !activeTextSub
                ? "bg-blue-100 text-blue-700"
                : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            }`}
          >
            すべて
          </button>
          {textSubEntities.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => handleTextSubFilter(e.id)}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                filterEntityIds.has(e.id)
                  ? "bg-blue-100 text-blue-700"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              }`}
            >
              {e.canonicalName}
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <details className="bg-white border border-slate-200 rounded-lg">
        <summary className="px-4 py-2.5 text-sm text-slate-500 cursor-pointer hover:text-slate-700">
          フィルタ
        </summary>
        <div className="px-4 pb-4 pt-1 space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs text-slate-500 mb-1">開始日</label>
              <input
                ref={dateFromRef}
                type="date"
                name="dateFrom"
                defaultValue={searchParams.get("dateFrom") ?? ""}
                className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">終了日</label>
              <input
                ref={dateToRef}
                type="date"
                name="dateTo"
                defaultValue={searchParams.get("dateTo") ?? ""}
                className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <AuthorFilter
            persons={entities.filter((e) => e.type === "person")}
            selected={filterAuthorIds}
            onToggle={toggleFilterAuthor}
          />
          <EntityFilter
            entityTypes={entityTypes}
            entitiesByType={entitiesByType}
            typeLabels={ENTITY_TYPE_LABELS}
            selected={filterEntityIds}
            onToggle={toggleFilterEntity}
          />
        </div>
      </details>
    </form>
  );
}
