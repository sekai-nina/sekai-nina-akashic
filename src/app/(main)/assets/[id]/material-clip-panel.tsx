import type { AssetMaterialProgress } from "@/lib/domain/material-clip-progress";
import { MATERIAL_PROGRESS_LABELS as L, MATERIAL_SOURCE_LABELS } from "@/lib/utils";
import { MaterialProgressButton } from "../../progress/material-button";
import Link from "next/link";

export function MaterialClipPanel({ items, editable }: { items: AssetMaterialProgress[]; editable: boolean }) {
  if (!items.length) return null;
  return <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
    <h2 className="text-sm font-semibold text-slate-700">{L.clipProgress}</h2>
    {items.map((item) => <div key={JSON.stringify([item.sourceKey, item.itemKey])} className="space-y-1">
      <Link href={`/progress/materials/${item.sourceKey}`} className="block text-xs text-indigo-700 hover:underline">
        {MATERIAL_SOURCE_LABELS[item.sourceKey]} · {item.itemTitle || item.itemKey}
      </Link>
      {item.sourceKey === "talk" && <p className="text-xs text-slate-500">{L.daily}</p>}
      <MaterialProgressButton sourceKey={item.sourceKey} itemKey={item.itemKey} value={!item.done}
        label={item.done ? L.undo : L.finish} editable={editable} />
    </div>)}
  </section>;
}
