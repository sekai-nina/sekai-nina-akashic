import Link from "next/link";
import type { UnreflectedClip } from "@/lib/domain/dossier-sync-queue";
import { ARTICLE_WORKFLOW_LABELS as L, ASSET_KIND_LABELS, formatDate } from "@/lib/utils";

/**
 * まだ記事に載っていないクリップの一覧 (`dossier-sync-queue.ts`)。見るだけで、
 * 追記・除外は上の差分 (`ArticleStep`) で行う。
 */
export function PendingClips({ clips }: { clips: UnreflectedClip[] }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{L.pendingClipsHelp}</p>
      <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200">
        {clips.map((c) => (
          <li key={c.assetId} className="px-3 py-2">
            <Link href={`/assets/${c.assetId}`} className="text-sm text-slate-800 hover:underline line-clamp-1">
              {c.title || "(無題)"}
            </Link>
            <p className="text-[11px] text-slate-500">
              {ASSET_KIND_LABELS[c.kind] ?? c.kind}
              {c.canonicalDate ? ` · ${formatDate(c.canonicalDate)}` : ""}
            </p>
            {c.excerpt && <p className="mt-1 text-xs text-slate-600 line-clamp-2">{c.excerpt}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
