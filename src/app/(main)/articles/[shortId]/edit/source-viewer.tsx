"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, X } from "lucide-react";
import type { ArticleSourceContent } from "@/lib/domain/article-source-content";
import { TEXT_TYPE_LABELS, cn } from "@/lib/utils";
import { getSourceContentAction } from "./actions";

export interface SourceTab {
  id: string;
  sourceNo: number | null;
  label: string;
}

/**
 * 本文を書きながら横で読む出典の中身。右の欄を差し替えて出す。
 * 開いた出典は覚えておき、切り替えても読み直さない
 */
export function SourceViewer({
  shortId,
  sources,
  openId,
  onOpen,
  onClose,
}: {
  shortId: string;
  sources: SourceTab[];
  openId: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [cache, setCache] = useState<Record<string, ArticleSourceContent | null | Error>>({});
  const content = cache[openId];

  useEffect(() => {
    if (openId in cache) return;
    let alive = true;
    getSourceContentAction(shortId, openId)
      .then((c) => alive && setCache((m) => ({ ...m, [openId]: c })))
      .catch((e: unknown) => alive && setCache((m) => ({ ...m, [openId]: e instanceof Error ? e : new Error(String(e)) })));
    return () => {
      alive = false;
    };
  }, [shortId, openId, cache]);

  const current = sources.find((s) => s.id === openId);

  return (
    <div className="bg-white border border-slate-200 rounded-lg flex flex-col max-h-[calc(100vh-2rem)]">
      <div className="flex items-start gap-2 p-3 border-b border-slate-100">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-400">出典 {current?.sourceNo != null ? `[${current.sourceNo}]` : ""}</div>
          <div className="text-sm font-medium text-slate-800 break-all">{current?.label || "(ラベルなし)"}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="出典を閉じる"
          className="shrink-0 p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
        >
          <X size={16} />
        </button>
      </div>

      {sources.length > 1 && (
        <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-100">
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onOpen(s.id)}
              title={s.label}
              className={cn(
                "h-6 min-w-7 px-1.5 rounded text-[11px] font-mono border",
                s.id === openId
                  ? "bg-slate-900 text-white border-slate-900"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              )}
            >
              {s.sourceNo != null ? s.sourceNo : "—"}
            </button>
          ))}
        </div>
      )}

      <div className="overflow-auto p-3 space-y-3 text-sm text-slate-700">
        {content === undefined ? (
          <p className="text-xs text-slate-400 inline-flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" /> 読み込んでいます…
          </p>
        ) : content instanceof Error ? (
          <p className="text-xs text-red-700">読み込めませんでした: {content.message}</p>
        ) : content === null ? (
          <p className="text-xs text-slate-400">この出典は見つかりませんでした</p>
        ) : (
          <SourceBody content={content} />
        )}
      </div>
    </div>
  );
}

function SourceBody({ content }: { content: ArticleSourceContent }) {
  const a = content.asset;
  return (
    <>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {a?.canonicalDate && <span className="text-slate-500">{a.canonicalDate.slice(0, 10)}</span>}
        {content.url && (
          <a href={content.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-blue-600 hover:underline">
            元のページ <ExternalLink size={11} />
          </a>
        )}
        {a && (
          <a href={`/assets/${a.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-blue-600 hover:underline">
            アセット <ExternalLink size={11} />
          </a>
        )}
      </div>

      {content.excerpt && (
        <div>
          <div className="text-xs font-medium text-slate-500 mb-1">抜粋</div>
          <p className="whitespace-pre-wrap text-sm bg-amber-50 border border-amber-200 rounded px-2 py-1.5">{content.excerpt}</p>
        </div>
      )}

      {!a ? (
        <p className="text-xs text-slate-400">紐づくアセットが無いか、閲覧できません</p>
      ) : (
        <>
          {a.imageUrl && (
            <img src={a.imageUrl} alt={a.title} className="max-w-full rounded border border-slate-200" />
          )}
          {a.texts.map((t, i) => (
            <div key={i}>
              {a.texts.length > 1 && (
                <div className="text-xs font-medium text-slate-500 mb-1">{TEXT_TYPE_LABELS[t.textType] ?? t.textType}</div>
              )}
              <RichText content={t.content} images={a.embeddedImages} />
            </div>
          ))}
          {!a.imageUrl && a.texts.length === 0 && <p className="text-xs text-slate-400">本文がありません</p>}
        </>
      )}
    </>
  );
}

/** ブログ本文。`{{IMG:<assetId>}}` を画像に置き換える (アセット詳細と同じ) */
function RichText({
  content,
  images,
}: {
  content: string;
  images: Record<string, { thumbnailUrl: string | null; title: string }>;
}) {
  const parts = content.split(/(\{\{IMG:[a-zA-Z0-9_-]+\}\})/);
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed">
      {parts.map((part, i) => {
        const id = part.match(/^\{\{IMG:([a-zA-Z0-9_-]+)\}\}$/)?.[1];
        if (!id) return <span key={i}>{part}</span>;
        const img = images[id];
        if (!img?.thumbnailUrl) return null;
        return (
          <img key={i} src={img.thumbnailUrl} alt={img.title} loading="lazy" className="block my-2 max-w-full rounded border border-slate-200" />
        );
      })}
    </div>
  );
}
