"use client";

import { GENERATION_LABELS } from "@/lib/members";

interface Person {
  id: string;
  canonicalName: string;
  generation?: number | null;
  reading?: string | null;
}

interface AuthorFilterProps {
  persons: Person[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}

/** 期別 → 五十音順。期が未設定の人は最後にまとめる。 */
function groupByGeneration(persons: Person[]) {
  const groups = new Map<number, Person[]>();
  const ungrouped: Person[] = [];

  for (const p of persons) {
    if (p.generation == null) {
      ungrouped.push(p);
      continue;
    }
    const list = groups.get(p.generation) ?? [];
    list.push(p);
    groups.set(p.generation, list);
  }

  // 読みが無い人は名前で比較するしかないので、読みのある人の後ろに置く
  const byReading = (a: Person, b: Person) => {
    if (!a.reading && !b.reading) return a.canonicalName.localeCompare(b.canonicalName, "ja");
    if (!a.reading) return 1;
    if (!b.reading) return -1;
    return a.reading.localeCompare(b.reading, "ja");
  };

  const ordered = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([generation, members]) => ({
      label: GENERATION_LABELS[generation] ?? `${generation}期生`,
      members: [...members].sort(byReading),
    }));

  if (ungrouped.length > 0) {
    ordered.push({ label: "その他", members: [...ungrouped].sort(byReading) });
  }
  return ordered;
}

export function AuthorFilter({ persons, selected, onToggle }: AuthorFilterProps) {
  const personMap = new Map(persons.map((p) => [p.id, p]));
  const value = [...selected].join(",");
  const groups = groupByGeneration(persons);

  return (
    <>
      <input type="hidden" name="authorIds" value={value} />
      <div>
        <label className="block text-xs text-slate-500 mb-1">
          著者 <span className="text-[10px] text-slate-400">(複数選択でOR)</span>
        </label>

        {selected.size > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {[...selected].map((id) => {
              const p = personMap.get(id);
              if (!p) return null;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onToggle(id)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 hover:bg-purple-200 transition-colors"
                >
                  {p.canonicalName}
                  <span className="text-purple-400">&times;</span>
                </button>
              );
            })}
          </div>
        )}

        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onToggle(e.target.value);
          }}
          className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
        >
          <option value="">
            {selected.size > 0 ? `${selected.size}名選択中` : "著者を追加..."}
          </option>
          {groups.map((group) => {
            const options = group.members.filter((p) => !selected.has(p.id));
            if (options.length === 0) return null;
            return (
              <optgroup key={group.label} label={group.label}>
                {options.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.canonicalName}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </div>
    </>
  );
}
