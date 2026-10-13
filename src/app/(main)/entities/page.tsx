import { getCachedEntities } from "@/lib/cache";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import type { ClearanceLevel } from "@prisma/client";
import { ENTITY_TYPE_BADGE, groupEntitiesByKey } from "@/lib/utils";
import Link from "next/link";

export default async function EntitiesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const entities = await getCachedEntities(session.user.clearance as ClearanceLevel);

  // ゲームのカード名タグは区分ごとに分け、既定で畳む (一般タグが埋もれないように)
  const groups = groupEntitiesByKey(entities);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">エンティティ</h1>
        <p className="text-slate-500 text-sm mt-1">
          人物・場所・ソース・イベント・タグの一覧 — 全 {entities.length} 件
        </p>
      </div>

      <div className="space-y-8">
        {groups.map(({ key, label, items }) => {
          const color =
            ENTITY_TYPE_BADGE[key.split(":")[0]] ?? "bg-slate-100 text-slate-700 border-slate-200";
          const isTagGroup = key.startsWith("tag:");

          const heading = (
            <span className="inline-flex items-center gap-2">
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>
                {label}
              </span>
              <span className="text-slate-400 text-xs font-normal">{items.length} 件</span>
            </span>
          );

          const list = (
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
          );

          return isTagGroup ? (
            <details key={key}>
              <summary className="text-sm font-semibold text-slate-700 mb-3 cursor-pointer select-none">
                {heading}
              </summary>
              {list}
            </details>
          ) : (
            <div key={key}>
              <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                {heading}
              </h2>
              {list}
            </div>
          );
        })}
      </div>
    </div>
  );
}
