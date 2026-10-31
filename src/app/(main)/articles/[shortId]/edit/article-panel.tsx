"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, ExternalLink, Loader2, X } from "lucide-react";
import { rankWikiLinkCandidates, type WikiLinkCandidate } from "@/lib/articles/wiki-link-complete";
import type { ArticleBacklink } from "@/lib/articles/related";
import { isListArticle } from "@/lib/articles/list-article";
import { ARTICLE_BACKLINK_VIA_LABELS, ARTICLE_FLAG_LABELS, ARTICLE_TYPE_LABELS } from "@/lib/utils";
import { getArticlePeekAction, type ArticlePeek } from "./actions";

const ICON_BUTTON = "shrink-0 p-1.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30";

/**
 * 記事パネル (#319 / #320)。右の欄を差し替えて出す (出典の SourceViewer と同じ置き方)。
 *
 * - 一覧: 記事をタイトルで探す・関連記事 (frontmatter の `related`) の並べ替えと削除・
 *   この記事を参照している記事。記事を押すと中身の画面に移る
 * - 中身: その記事の本文を読み、使い方を 3 つから選ぶ (本文中にリンク / 脚注で出典にする /
 *   関連記事に並べる)。何がどうなるかをボタンの下に書く
 *
 * 関連記事と出典の予約は記事のフォームと一緒に保存する (hidden input は親が持つ)。
 */
export function ArticlePanel({
  candidates,
  related,
  onRelatedChange,
  backlinks,
  onInsert,
  onAddSource,
  onClose,
  disabled,
}: {
  candidates: WikiLinkCandidate[];
  related: string[];
  onRelatedChange: (related: string[]) => void;
  backlinks: ArticleBacklink[];
  /** 本文のカーソル位置に `[[タイトル]]` を入れる */
  onInsert: (title: string) => void;
  /** 出典に足す (#320)。本文のカーソル位置に ^[n] を入れ、出典 [n] を予約する。n を返す */
  onAddSource: (candidate: WikiLinkCandidate) => number;
  onClose: () => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  /** 中身を開いている記事 */
  const [openShortId, setOpenShortId] = useState<string | null>(null);
  const hits = useMemo(() => (query.trim() ? rankWikiLinkCandidates(candidates, query, 30) : []), [candidates, query]);
  const byTitle = useMemo(() => new Map(candidates.map((c) => [c.title, c])), [candidates]);
  const byShortId = useMemo(() => new Map(candidates.map((c) => [c.shortId, c])), [candidates]);
  const open = openShortId ? byShortId.get(openShortId) : undefined;

  const move = (i: number, d: -1 | 1) => {
    const next = [...related];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onRelatedChange(next);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg flex flex-col max-h-[calc(100vh-2rem)]">
      <div className="flex items-center gap-2 p-3 border-b border-slate-100">
        {open ? (
          <button
            type="button"
            onClick={() => setOpenShortId(null)}
            className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft size={14} /> 一覧に戻る
          </button>
        ) : (
          <div className="text-sm font-medium text-slate-800">記事</div>
        )}
        <div className="flex-1" />
        <button type="button" onClick={onClose} aria-label="記事パネルを閉じる" className={ICON_BUTTON}>
          <X size={16} />
        </button>
      </div>

      {open ? (
        <ArticleDetail
          key={open.shortId}
          candidate={open}
          inRelated={related.includes(open.title)}
          onInsert={() => onInsert(open.title)}
          onAddSource={() => onAddSource(open)}
          onToggleRelated={() =>
            onRelatedChange(related.includes(open.title) ? related.filter((t) => t !== open.title) : [...related, open.title])
          }
          disabled={disabled}
        />
      ) : (
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
            {!query.trim() && (
              <p className="text-xs text-slate-400">記事を押すと中身を読めます。そこから、この記事への使い方を選びます</p>
            )}
            {query.trim() && hits.length === 0 && <p className="text-xs text-slate-400">見つかりません</p>}
            {hits.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {hits.map((c) => (
                  <li key={c.shortId}>
                    <ArticleRow candidate={c} onOpen={() => setOpenShortId(c.shortId)} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 関連記事 */}
          <section>
            <h3 className="text-xs font-medium text-slate-500 mb-1">
              関連記事 {related.length} 件（記事ページの下に、この順で出る）
            </h3>
            {related.length === 0 ? (
              <p className="text-xs text-slate-400">なし</p>
            ) : (
              <ol className="space-y-0.5">
                {related.map((title, i) => {
                  const c = byTitle.get(title);
                  return (
                    <li key={title} className="flex items-center gap-1">
                      <span className="w-5 shrink-0 text-xs text-slate-400 text-right">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        {c ? (
                          <button
                            type="button"
                            onClick={() => setOpenShortId(c.shortId)}
                            className="text-left text-sm text-slate-800 hover:text-blue-700 hover:underline break-all"
                          >
                            {title}
                          </button>
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
                {backlinks.map((b) => {
                  const c = byShortId.get(b.shortId);
                  return (
                    <li key={b.shortId} className="flex items-baseline gap-1.5 flex-wrap">
                      {c ? (
                        <button
                          type="button"
                          onClick={() => setOpenShortId(b.shortId)}
                          className="text-left text-sm text-slate-800 hover:text-blue-700 hover:underline break-all"
                        >
                          {b.title || "(無題)"}
                        </button>
                      ) : (
                        <span className="text-sm text-slate-800 break-all">{b.title || "(無題)"}</span>
                      )}
                      <span className="text-xs text-slate-400">
                        {[...b.via.map((v) => ARTICLE_BACKLINK_VIA_LABELS[v]), b.draft ? ARTICLE_FLAG_LABELS.draft : null]
                          .filter(Boolean)
                          .join(" ・ ")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function marksOf(c: WikiLinkCandidate): string[] {
  return [
    c.type ? ARTICLE_TYPE_LABELS[c.type] : null,
    c.draft ? ARTICLE_FLAG_LABELS.draft : null,
    c.unlisted ? ARTICLE_FLAG_LABELS.unlisted : null,
  ].filter((m): m is string => m != null);
}

/** 検索結果の 1 行。押すと中身の画面へ */
function ArticleRow({ candidate: c, onOpen }: { candidate: WikiLinkCandidate; onOpen: () => void }) {
  const marks = marksOf(c);
  return (
    <button type="button" onClick={onOpen} className="w-full flex items-center gap-2 py-2 text-left hover:bg-slate-50 rounded px-1 -mx-1">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-800 break-all">{c.title}</div>
        {marks.length > 0 && <div className="text-xs text-slate-400">{marks.join(" ・ ")}</div>}
      </div>
      <ChevronRight size={14} className="shrink-0 text-slate-300" />
    </button>
  );
}

/** 記事の中身と、使い方の 3 択 */
function ArticleDetail({
  candidate: c,
  inRelated,
  onInsert,
  onAddSource,
  onToggleRelated,
  disabled,
}: {
  candidate: WikiLinkCandidate;
  inRelated: boolean;
  onInsert: () => void;
  onAddSource: () => number;
  onToggleRelated: () => void;
  disabled?: boolean;
}) {
  const [peek, setPeek] = useState<ArticlePeek | null | Error | undefined>(undefined);
  /** 直前にした操作の結果 (ボタンの下に出す) */
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getArticlePeekAction(c.shortId)
      .then((p) => alive && setPeek(p))
      .catch((e: unknown) => alive && setPeek(e instanceof Error ? e : new Error(String(e))));
    return () => {
      alive = false;
    };
  }, [c.shortId]);

  const marks = [...marksOf(c), peek && !(peek instanceof Error) ? peek.dateLabel : null].filter(Boolean);

  return (
    <div className="flex flex-col min-h-0 overflow-y-auto">
      <div className="px-3 pt-3">
        <div className="text-sm font-medium text-slate-900 break-all">{c.title}</div>
        <div className="flex items-baseline gap-2 flex-wrap text-xs text-slate-400 mt-0.5">
          {marks.length > 0 && <span>{marks.join(" ・ ")}</span>}
          <a
            href={`/articles/${c.shortId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
          >
            新しいタブで開く <ExternalLink size={11} />
          </a>
        </div>
      </div>

      {/* 本文 */}
      <div className="m-3 mb-0 border border-slate-200 rounded bg-[#f8f7f4] p-3 overflow-y-auto max-h-[40vh] min-h-24 shrink-0">
        {peek === undefined ? (
          <p className="text-xs text-slate-400 inline-flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" /> 読み込み中…
          </p>
        ) : peek instanceof Error ? (
          <p className="text-xs text-red-700">読み込めませんでした: {peek.message}</p>
        ) : peek === null ? (
          <p className="text-xs text-slate-400">記事が見つかりません</p>
        ) : (
          <div
            className="article-content text-sm"
            data-list-article={isListArticle(peek.title) ? "" : undefined}
            // 詳細ページと同じ。自リポジトリの記事 Markdown なので入力は信頼できる
            dangerouslySetInnerHTML={{ __html: peek.html }}
          />
        )}
      </div>

      {/* 使い方 */}
      <div className="p-3 space-y-2">
        <div className="text-xs font-medium text-slate-500">この記事をどう使う？</div>
        <UseButton
          label="本文中にリンクを張る"
          description={`本文のカーソル位置に [[${c.title}]] を入れます。公開サイトでは、この記事への青いリンクになります`}
          disabled={disabled}
          onClick={() => {
            onInsert();
            setDone("本文にリンクを入れました");
          }}
        />
        <UseButton
          label="根拠として脚注を付ける"
          description="本文のカーソル位置に ^[n] を入れ、この記事を出典 [n] にします。公開サイトでは記事下の「出典」に載ります（画面の「保存」で確定）"
          disabled={disabled}
          onClick={() => {
            const n = onAddSource();
            setDone(`本文に ^[${n}] を入れ、出典 [${n}] にしました（保存で確定）`);
          }}
        />
        <UseButton
          label={inRelated ? "「関連記事」から外す" : "記事の最後の「関連記事」に並べる"}
          description={
            inRelated
              ? "いまは関連記事に入っています。外しても本文は変わりません"
              : "本文は変えません。公開サイトの記事ページの下にある「関連記事」に、この記事を優先して出します"
          }
          disabled={disabled}
          onClick={() => {
            onToggleRelated();
            setDone(inRelated ? "関連記事から外しました（保存で確定）" : "関連記事に入れました（保存で確定）");
          }}
        />
        {done && <p className="text-xs text-green-700">{done}</p>}
      </div>
    </div>
  );
}

function UseButton({
  label,
  description,
  onClick,
  disabled,
}: {
  label: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left rounded border border-slate-300 px-3 py-2 hover:bg-slate-50 hover:border-slate-400 disabled:opacity-50"
    >
      <div className="text-sm font-medium text-slate-800">{label}</div>
      <div className="text-xs text-slate-500 mt-0.5">{description}</div>
    </button>
  );
}
