import { getCachedEntities } from "@/lib/cache";
import { ENTITY_TYPE_LABELS } from "@/lib/utils";
import Link from "next/link";

export default async function EntitiesPage() {
  const entities = await getCachedEntities();

  const entityTypes = [...new Set(entities.map((e) => e.type))];
  const entitiesByType = Object.fromEntries(
    entityTypes.map((t) => [t, entities.filter((e) => e.type === t)])
  );

  const typeColors: Record<string, string> = {
    person: "bg-purple-100 text-purple-800 border-purple-200",
    place: "bg-green-100 text-green-800 border-green-200",
    source: "bg-orange-100 text-orange-800 border-orange-200",
    event: "bg-blue-100 text-blue-800 border-blue-200",
    tag: "bg-slate-100 text-slate-700 border-slate-200",
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">エンティティ</h1>
        <p className="text-slate-500 text-sm mt-1">
          人物・場所・ソース・イベント・タグの一覧 — 全 {entities.length} 件
        </p>
      </div>

      <div className="space-y-8">
        {entityTypes.map((type) => {
          const items = entitiesByType[type];
          const color = typeColors[type] ?? "bg-slate-100 text-slate-700 border-slate-200";

          return (
            <div key={type}>
              <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>
                  {ENTITY_TYPE_LABELS[type] ?? type}
                </span>
                <span className="text-slate-400 text-xs font-normal">{items.length} 件</span>
              </h2>
              <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
                {items.map((entity) => (
                  <Link
                    key={entity.id}
                    href={`/entities/${entity.id}`}
                    className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors"
                  >
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-slate-900">
                        {entity.canonicalName}
                      </span>
                      {entity.description && (
                        <p className="text-xs text-slate-500 mt-0.5 truncate">
                          {entity.description}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 ml-4 text-right">
                      <span className="text-sm font-semibold text-slate-700">
                        {entity._count.assets}
                      </span>
                      <span className="text-xs text-slate-400 ml-1">件</span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
