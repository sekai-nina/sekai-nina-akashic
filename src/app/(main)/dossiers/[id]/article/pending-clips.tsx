import Link from "next/link";
import type { PendingClip } from "@/lib/domain/dossier-sync-queue";
import type { ClipMedia } from "@/lib/domain/nina-appearance";
import { NinaAppearanceToggle } from "./nina-appearance-toggle";
import { ARTICLE_WORKFLOW_LABELS as L, ASSET_KIND_LABELS, formatDate } from "@/lib/utils";

/**
 * まだ記事に載っていないクリップの一覧 (`dossier-sync-queue.ts`)。追記・除外は上の差分 (`ArticleStep`) で行う。
 * 画像・動画は縮小画像と、坂井新奈が出ているかの切り替えを出す (おでかけ記事の関連メディアを分ける印)
 */
export function PendingClips({ clips, media = {} }: { clips: PendingClip[]; media?: Record<string, ClipMedia> }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{L.pendingClipsHelp}</p>
      <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200">
        {clips.map((c) => {
          const m = media[c.assetId];
          return (
          <li key={c.itemId} className="px-3 py-2 flex gap-3">
            {m?.thumbnailUrl && (
              <Link href={`/assets/${c.assetId}`} className="shrink-0">
                <img src={m.thumbnailUrl} alt="" loading="lazy" className="h-20 w-20 rounded border border-slate-200 object-cover" />
              </Link>
            )}
            <div className="min-w-0 flex-1">
            <Link href={`/assets/${c.assetId}`} className="text-sm text-slate-800 hover:underline line-clamp-1">
              {c.title || "(無題)"}
            </Link>
            <p className="text-[11px] text-slate-500">
              {ASSET_KIND_LABELS[c.kind] ?? c.kind}
              {c.canonicalDate ? ` · ${formatDate(c.canonicalDate)}` : ""}
            </p>
            {c.excerpt && (
              <blockquote className="mt-1.5 border-l-2 border-slate-300 pl-2 text-xs text-slate-700 whitespace-pre-wrap">
                {c.excerpt}
              </blockquote>
            )}
            {c.note && (
              <p className="mt-1.5 rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-700 whitespace-pre-wrap">
                <span className="mr-1 text-[10px] text-slate-400">{L.clipNote}</span>
                {c.note}
              </p>
            )}
            {m && (
              <div className="mt-1.5">
                <NinaAppearanceToggle assetId={c.assetId} initial={m.appearance} author={m.author} />
              </div>
            )}
            </div>
          </li>
          );
        })}
      </ul>
    </div>
  );
}
