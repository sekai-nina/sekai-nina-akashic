"use client";

interface Entity {
  id: string;
  canonicalName: string;
  type: string;
}

interface EntityFilterProps {
  entityTypes: string[];
  entitiesByType: Record<string, Entity[]>;
  typeLabels: Record<string, string>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** "any" = いずれかを含む (OR、既定) / "all" = すべてを含む (AND) */
  match: "any" | "all";
  onMatchChange: (match: "any" | "all") => void;
}

export function EntityFilter({
  entityTypes,
  entitiesByType,
  typeLabels,
  selected,
  onToggle,
  match,
  onMatchChange,
}: EntityFilterProps) {
  const value = [...selected].join(",");

  const entityMap = new Map<string, Entity>();
  for (const ents of Object.values(entitiesByType)) {
    for (const e of ents) {
      entityMap.set(e.id, e);
    }
  }

  return (
    <>
      <input type="hidden" name="entityIds" value={value} />

      {selected.size > 1 && (
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-xs text-slate-500">絞り込み方</span>
          {([
            { key: "any", label: "いずれかを含む" },
            { key: "all", label: "すべてを含む" },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => onMatchChange(opt.key)}
              className={`px-2 py-0.5 rounded-full text-xs transition-colors ${
                match === opt.key
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {[...selected].map((id) => {
            const ent = entityMap.get(id);
            if (!ent) return null;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onToggle(id)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
              >
                {ent.canonicalName}
                <span className="text-blue-400">&times;</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        {entityTypes.map((t) => (
          <div key={t}>
            <label className="block text-xs text-slate-500 mb-1">
              {typeLabels[t] ?? t}
            </label>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) onToggle(e.target.value);
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
