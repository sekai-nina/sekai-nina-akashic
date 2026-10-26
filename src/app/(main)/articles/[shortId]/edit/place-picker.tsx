"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, EyeOff, X } from "lucide-react";

export interface PlaceOption {
  id: string;
  name: string;
  area: string | null;
  /** push で frontmatter の locations に載るか (Place が public / internal) */
  published: boolean;
}

const INPUT =
  "w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50";

/**
 * 記事の聖地 (ArticlePlace, #283)。並びは記事内の訪問順で、push で `locations` になる。
 * 非公開 (confidential 以上) の聖地も付けられるが、公開サイトには出ない (バッジで示す)。
 *
 * 保存は記事のフォームと一緒 (`placeIds` の hidden を並べる)。`placesField` は
 * 「この欄を送った」の印で、0 件にした場合と欄が無い場合を区別する。
 */
export function PlacePicker({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  options: PlaceOption[];
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const byId = new Map(options.map((o) => [o.id, o]));
  const q = query.trim().toLowerCase();
  const candidates = q
    ? options
        .filter((o) => !value.includes(o.id))
        .filter((o) => o.name.toLowerCase().includes(q) || (o.area ?? "").toLowerCase().includes(q))
        .slice(0, 8)
    : [];

  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };

  return (
    <div>
      <input type="hidden" name="placesField" value="1" />
      {value.map((id) => (
        <input key={id} type="hidden" name="placeIds" value={id} />
      ))}

      {value.length === 0 ? (
        <p className="text-xs text-slate-400 mb-2">聖地なし</p>
      ) : (
        <ol className="space-y-1 mb-2">
          {value.map((id, i) => {
            const p = byId.get(id);
            return (
              <li key={id} className="flex items-center gap-1.5 text-sm text-slate-700">
                <span className="font-mono text-xs text-slate-400 w-5 shrink-0">{i + 1}.</span>
                <span className="truncate">{p?.name ?? id}</span>
                {p && !p.published && (
                  <span
                    className="inline-flex items-center gap-0.5 shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200"
                    title="この聖地は非公開 (confidential 以上) なので、push しても公開サイトの locations には出ません"
                  >
                    <EyeOff size={11} />
                    サイトに出ない
                  </span>
                )}
                <span className="ml-auto flex shrink-0">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={disabled || i === 0}
                    className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                    aria-label="上へ"
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={disabled || i === value.length - 1}
                    className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                    aria-label="下へ"
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange(value.filter((v) => v !== id))}
                    disabled={disabled}
                    className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
                    aria-label="外す"
                  >
                    <X size={13} />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // Enter でフォーム (記事の保存) が送られないように
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
        placeholder="聖地を名前・エリアで探して追加"
        disabled={disabled}
        className={INPUT}
      />
      {candidates.length > 0 && (
        <ul className="mt-1 border border-slate-200 rounded divide-y divide-slate-100">
          {candidates.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => {
                  onChange([...value, o.id]);
                  setQuery("");
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 flex items-center gap-1.5"
              >
                <span className="truncate">{o.name}</span>
                {o.area && <span className="text-xs text-slate-400 shrink-0">{o.area}</span>}
                {!o.published && <EyeOff size={12} className="text-amber-700 shrink-0" aria-label="サイトに出ない" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {q && candidates.length === 0 && <p className="text-xs text-slate-400 mt-1">該当する聖地がありません</p>}
    </div>
  );
}
