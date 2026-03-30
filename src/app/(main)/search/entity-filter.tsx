"use client";

import { useState } from "react";

interface Entity {
  id: string;
  canonicalName: string;
  type: string;
}

interface EntityFilterProps {
  entityTypes: string[];
  entitiesByType: Record<string, Entity[]>;
  typeLabels: Record<string, string>;
  initialSelected: string[];
}

export function EntityFilter({
  entityTypes,
  entitiesByType,
  typeLabels,
  initialSelected,
}: EntityFilterProps) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initialSelected)
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // hidden input にカンマ区切りで渡す
  const value = [...selected].join(",");

  // 全エンティティのマップ
  const entityMap = new Map<string, Entity>();
  for (const ents of Object.values(entitiesByType)) {
    for (const e of ents) {
      entityMap.set(e.id, e);
    }
  }

  return (
    <>
      <input type="hidden" name="entityIds" value={value} />

      {/* 選択済みタグの表示 */}
      {selected.size > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {[...selected].map((id) => {
            const ent = entityMap.get(id);
            if (!ent) return null;
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggle(id)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
              >
                {ent.canonicalName}
                <span className="text-blue-400">&times;</span>
              </button>
            );
          })}
        </div>
      )}

      {/* タイプ別のドロップダウン */}
      <div className="flex flex-wrap gap-3">
        {entityTypes.map((t) => (
          <div key={t}>
            <label className="block text-xs text-slate-500 mb-1">
              {typeLabels[t] ?? t}
            </label>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) toggle(e.target.value);
              }}
              className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">
                {entitiesByType[t].some((e) => selected.has(e.id))
                  ? `${entitiesByType[t].filter((e) => selected.has(e.id)).length}件選択中`
                  : "すべて"}
              </option>
              {entitiesByType[t]
                .filter((e) => !selected.has(e.id))
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.canonicalName}
                  </option>
                ))}
            </select>
          </div>
        ))}
      </div>
    </>
  );
}
