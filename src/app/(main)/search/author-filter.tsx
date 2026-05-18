"use client";

interface Person {
  id: string;
  canonicalName: string;
}

interface AuthorFilterProps {
  persons: Person[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}

export function AuthorFilter({ persons, selected, onToggle }: AuthorFilterProps) {
  const personMap = new Map(persons.map((p) => [p.id, p]));
  const value = [...selected].join(",");

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
          {persons
            .filter((p) => !selected.has(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.canonicalName}
              </option>
            ))}
        </select>
      </div>
    </>
  );
}
