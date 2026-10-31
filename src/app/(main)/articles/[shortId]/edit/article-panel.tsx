"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, X } from "lucide-react";
import { rankWikiLinkCandidates, type WikiLinkCandidate } from "@/lib/articles/wiki-link-complete";
import type { ArticleBacklink } from "@/lib/articles/related";
import { ARTICLE_BACKLINK_VIA_LABELS, ARTICLE_FLAG_LABELS, ARTICLE_TYPE_LABELS } from "@/lib/utils";

const SMALL_BUTTON =
  "shrink-0 px-2 py-1 rounded border border-slate-300 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40";
const ICON_BUTTON = "shrink-0 p-1.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30";

/**
 * 記事パネル (#319)。右の欄を差し替えて出す (出典の SourceViewer と同じ置き方)。
 *
 * - 記事をタイトルで探し、本文のカーソル位置に `[[タイトル]]` を入れるか、関連記事に足す
 * - 関連記事 (frontmatter の `related`) の並べ替え・削除。保存は記事のフォームと一緒
 *   (hidden input は親が持つ。このパネルを閉じても値は消えない)
 * - この記事を参照している記事 (本文の `[[ ]]` / 他記事の `related`)。保存済みのタイトルで引く
 */
export function ArticlePanel({
  candidates,
  related,
  onRelatedChange,
  backlinks,
  onInsert,
  onClose,
  disabled,
}: {
  candidates: WikiLinkCandidate[];
  related: string[];
  onRelatedChange: (related: string[]) => void;
  backlinks: ArticleBacklink[];
  onInsert: (title: string) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const hits = useMemo(() => (query.trim() ? rankWikiLinkCandidates(candidates, query, 30) : []), [candidates, query]);
  const byTitle = useMemo(() => new Map(candidates.map((c) => [c.title, c])), [candidates]);

  const move = (i: number, d: -1 | 1) => {
    const next = [...related];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onRelatedChange(next);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg flex flex-col max-h-[calc(100vh-2rem)]">
      <div className="flex items-center gap-2 p-3 border-b border-slate-100">
        <div className="flex-1 text-sm font-medium text-slate-800">記事</div>
        <button type="button" onClick={onClose} aria-label="記事パネルを閉じる" className={ICON_BUTTON}>
          <X size={16} />
        </button>
      </div>

      <div className="overflow-y-auto p-3 space-y-5">
        {/* 検索 */}
        <section className="space-y-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Enter で記事のフォームが送信されないように
            onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
            placeholder="記事をタイトルで探す"
            aria-label="記事をタイトルで探す"
            className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {query.trim() && hits.length === 0 && <p className="text-xs text-slate-400">見つかりません</p>}
          {hits.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {hits.map((c) => (
                <li key={c.shortId} className="py-1.5">
                  <ArticleTitle candidate={c} />
                  <div className="flex gap-1.5 mt-1">
                    <button type="button" disabled={disabled} onClick={() => onInsert(c.title)} className={SMALL_BUTTON}>
                      本文に挿入
                    </button>
                    <button
                      type="button"
                      disabled={disabled || related.includes(c.title)}
                      onClick={() => onRelatedChange([...related, c.title])}
                      className={SMALL_BUTTON}
                    >
                      {related.includes(c.title) ? "関連記事に追加済み" : "関連記事に追加"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 関連記事 */}
        <section>
          <h3 className="text-xs font-medium text-slate-500 mb-1">関連記事 {related.length} 件（この順で公開サイトに出る）</h3>
          {related.length === 0 ? (
            <p className="text-xs text-slate-400">なし。上で探して「関連記事に追加」</p>
          ) : (
            <ol className="space-y-0.5">
              {related.map((title, i) => {
                const c = byTitle.get(title);
                return (
                  <li key={title} className="flex items-center gap-1">
                    <span className="w-5 shrink-0 text-xs text-slate-400 text-right">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      {c ? (
                        <ArticleTitle candidate={c} />
                      ) : (
                        <span className="text-sm text-slate-700 break-all">
                          {title} <span className="text-xs text-amber-700">（この題の記事が無い）</span>
                        </span>
                      )}
                    </div>
                    <button type="button" disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label="上へ" className={ICON_BUTTON}>
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      disabled={disabled || i === related.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label="下へ"
                      className={ICON_BUTTON}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onRelatedChange(related.filter((t) => t !== title))}
                      aria-label="関連記事から外す"
                      className={ICON_BUTTON}
                    >
                      <X size={14} />
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* 被リンク */}
        <section>
          <h3 className="text-xs font-medium text-slate-500 mb-1">この記事を参照している記事 {backlinks.length} 件</h3>
          {backlinks.length === 0 ? (
            <p className="text-xs text-slate-400">なし</p>
          ) : (
            <ul className="space-y-1">
              {backlinks.map((b) => (
                <li key={b.shortId} className="flex items-baseline gap-1.5 flex-wrap">
                  <a
                    href={`/articles/${b.shortId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-slate-800 hover:text-blue-700 hover:underline break-all"
                  >
                    {b.title || "(無題)"}
                  </a>
                  <span className="text-xs text-slate-400">
                    {[...b.via.map((v) => ARTICLE_BACKLINK_VIA_LABELS[v]), b.draft ? ARTICLE_FLAG_LABELS.draft : null]
                      .filter(Boolean)
                      .join(" ・ ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** タイトル + 種類・下書き・限定公開の印。タイトルは新しいタブで記事を開く */
function ArticleTitle({ candidate: c }: { candidate: WikiLinkCandidate }) {
  const marks = [
    c.type ? ARTICLE_TYPE_LABELS[c.type] : null,
    c.draft ? ARTICLE_FLAG_LABELS.draft : null,
    c.unlisted ? ARTICLE_FLAG_LABELS.unlisted : null,
  ].filter(Boolean);
  return (
    <div className="flex items-baseline gap-1.5 flex-wrap">
      <a
        href={`/articles/${c.shortId}`}
        target="_blank"
        rel="noreferrer"
        title="新しいタブで開く"
        className="text-sm text-slate-800 hover:text-blue-700 hover:underline break-all inline-flex items-baseline gap-1"
      >
        {c.title}
        <ExternalLink size={11} className="shrink-0 text-slate-300" />
      </a>
      {marks.length > 0 && <span className="text-xs text-slate-400">{marks.join(" ・ ")}</span>}
    </div>
  );
}
