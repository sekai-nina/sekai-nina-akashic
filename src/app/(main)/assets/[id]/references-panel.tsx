"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Scissors, Trash2 } from "lucide-react";
import { deleteClipsAction } from "@/app/(main)/clips/actions";
import type { ArticleReferenceForAsset } from "@/lib/domain/articles";
import { ARTICLE_SOURCE_STATUS_LABELS, formatDate } from "@/lib/utils";

/**
 * アセット詳細の「記事での参照」と「クリップ」(#41)。
 *
 * - 記事での参照: このアセットを出典にしている記事と、その記述 (本文で ^[n] を含む段落)。
 *   「ここはもう記事 X に書いた」を、記事を開かずに分からせる
 * - クリップ: プールに入っているこのアセットの抜粋。本文上のハイライトと対になる
 */

interface ClipView {
  id: string;
  note: string;
  excerpt: string;
  /** 本文上に色が付いているか (= 位置が今の本文と一致している) */
  located: boolean;
  createdAt: string;
  createdBy: string | null;
}

interface AssetReferencesPanelProps {
  references: ArticleReferenceForAsset[];
  clips: ClipView[];
  canEdit: boolean;
}

export function AssetReferencesPanel({ references, clips, canEdit }: AssetReferencesPanelProps) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
      {references.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            記事での参照 ({references.length})
          </h2>
          <ul className="space-y-2.5">
            {references.map((r) => (
              <li key={r.sourceId} className="text-sm">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Link
                    href={`/articles/${r.article.shortId}`}
                    className="font-medium text-indigo-700 hover:underline break-words"
                  >
                    {r.article.title || r.article.path}
                  </Link>
                  {r.status === "applied" && r.sourceNo != null ? (
                    <span className="text-[10px] text-slate-400">[{r.sourceNo}]</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                      {ARTICLE_SOURCE_STATUS_LABELS[r.status] ?? r.status}
                    </span>
                  )}
                </div>
                {r.paragraphs.length > 0 ? (
                  <ul className="mt-1 space-y-1">
                    {r.paragraphs.map((p, i) => (
                      <li
                        key={i}
                        className="text-xs text-slate-600 border-l-2 border-indigo-200 pl-2 whitespace-pre-wrap line-clamp-4"
                      >
                        {p}
                      </li>
                    ))}
                  </ul>
                ) : r.status === "applied" ? (
                  <p className="mt-1 text-[11px] text-slate-400">本文にまだ ^[{r.sourceNo}] がありません</p>
                ) : r.excerpt ? (
                  <p className="mt-1 text-xs text-slate-500 border-l-2 border-slate-200 pl-2 line-clamp-3">
                    {r.excerpt}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {clips.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Scissors className="h-3.5 w-3.5 text-sky-600" />
              クリップ ({clips.length})
            </span>
            <Link href="/clips" className="text-[11px] font-normal normal-case tracking-normal text-indigo-600 hover:underline">
              一覧へ →
            </Link>
          </h2>
          <ul className="space-y-2">
            {clips.map((c) => (
              <ClipRow key={c.id} clip={c} canEdit={canEdit} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ClipRow({ clip, canEdit }: { clip: ClipView; canEdit: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    if (!confirm("このクリップを削除しますか？")) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteClipsAction([clip.id]);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <li className="text-xs border border-sky-100 bg-sky-50/40 rounded-md px-2.5 py-2">
      {clip.excerpt && (
        <>
          <blockquote className="text-slate-700 whitespace-pre-wrap line-clamp-4">{clip.excerpt}</blockquote>
          {!clip.located && (
            <span
              className="inline-block mt-1 text-[10px] px-1 rounded bg-slate-100 text-slate-500"
              title="本文内の位置が確定していないため、本文上のハイライトは出ません"
            >
              位置未確定
            </span>
          )}
        </>
      )}
      {clip.note && (
        <p className={`text-slate-600 whitespace-pre-wrap ${clip.excerpt ? "mt-1 border-t border-sky-100 pt-1" : ""}`}>
          {clip.note}
        </p>
      )}
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-slate-400">
        <span>
          {formatDate(clip.createdAt)}
          {clip.createdBy && <> ・ {clip.createdBy}</>}
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={remove}
            disabled={isPending}
            title="削除"
            className="inline-flex items-center gap-0.5 text-slate-400 hover:text-red-600 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-red-600">{error}</p>}
    </li>
  );
}
