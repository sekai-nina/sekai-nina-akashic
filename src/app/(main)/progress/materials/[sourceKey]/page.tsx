import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { isMaterialSourceKey } from "@/lib/clip-progress/material-items";
import { MaterialProgressInputError, listMaterialClipProgress } from "@/lib/domain/material-clip-progress";
import { MATERIAL_PROGRESS_LABELS as L, MATERIAL_SOURCE_LABELS } from "@/lib/utils";
import { MaterialProgressButton, MaterialProgressControls } from "../../material-button";

export default async function MaterialProgressPage({ params, searchParams }: {
  params: Promise<{ sourceKey: string }>;
  searchParams: Promise<{ other?: string; page?: string }>;
}) {
  const { sourceKey } = await params;
  if (!isMaterialSourceKey(sourceKey)) notFound();
  const session = await auth();
  if (!session?.user) notFound();
  const sp = await searchParams;
  const other = sp.other === "1";
  const requestedPage = Number(sp.page);
  const progress = await listMaterialClipProgress(session.user, sourceKey, {
    other, page: Number.isFinite(requestedPage) ? requestedPage : 1,
  }).catch((error: unknown) => {
    if (error instanceof MaterialProgressInputError) notFound();
    throw error;
  });
  const editable = ["admin", "member"].includes(session.user.role);
  const href = (page: number, showOther = other) => `/progress/materials/${sourceKey}?page=${page}${showOther ? "&other=1" : ""}`;
  const percent = progress.total ? Math.round(progress.done / progress.total * 100) : 0;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">{MATERIAL_SOURCE_LABELS[sourceKey]} — {percent}% {L.done}</h2>
        <p className="mt-1 text-sm text-slate-500">{progress.done} / {progress.total} 件</p>
        <progress className="mt-2 h-2 w-full accent-emerald-600" value={progress.done} max={Math.max(1, progress.total)} aria-label={L.clipProgress} />
        <p className="mt-2 text-xs text-slate-500">{L.description}</p>
      </div>
      <nav className="flex gap-4 text-sm">
        <Link className={!other ? "font-semibold underline" : "text-slate-500"} href={href(1, false)}>{L.relevant} ({progress.total})</Link>
        <Link className={other ? "font-semibold underline" : "text-slate-500"} href={href(1, true)}>{L.other} ({progress.otherTotal})</Link>
      </nav>
      {sourceKey === "talk" && <p className="text-xs text-slate-500">{L.daily}</p>}
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {progress.items.map((item) => (
          <li key={item.itemKey} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="break-words text-sm font-medium">
                {item.assetId ? <Link className="text-indigo-700 hover:underline" href={`/assets/${item.assetId}`}>{item.itemTitle || item.itemKey}</Link>
                  : item.articleShortId ? <Link className="text-indigo-700 hover:underline" href={`/articles/${item.articleShortId}`}>{item.itemTitle}</Link>
                    : <a className="text-indigo-700 hover:underline" href={/^https?:\/\//.test(item.itemKey) ? item.itemKey : undefined} target="_blank" rel="noreferrer">{item.itemTitle || item.itemKey}</a>}
              </div>
              <p className="mt-1 text-xs text-slate-500">{item.itemDate} · {L.clips} {item.clipCount}{!item.assetId && ` · ${L.noAssets}`}{!item.automatic && item.included && ` · ${L.manual}`}</p>
            </div>
            <MaterialProgressControls>
              {other ? <MaterialProgressButton sourceKey={sourceKey} itemKey={item.itemKey} field="included" value={true} label={L.include} editable={editable} /> : <>
                <MaterialProgressButton sourceKey={sourceKey} itemKey={item.itemKey} value={!item.done} editable={editable} />
                {!item.automatic && item.included && <MaterialProgressButton sourceKey={sourceKey} itemKey={item.itemKey} field="included" value={false} label={L.exclude} editable={editable} />}
              </>}
            </MaterialProgressControls>
          </li>
        ))}
        {!progress.items.length && <li className="p-6 text-center text-sm text-slate-500">{L.empty}</li>}
      </ul>
      <nav className="flex items-center justify-between text-sm">
        {progress.page > 1 ? <Link href={href(progress.page - 1)}>{L.previous}</Link> : <span />}
        <span>{progress.page} / {Math.max(1, Math.ceil(progress.filteredTotal / progress.pageSize))}</span>
        {progress.page * progress.pageSize < progress.filteredTotal ? <Link href={href(progress.page + 1)}>{L.next}</Link> : <span />}
      </nav>
    </div>
  );
}
