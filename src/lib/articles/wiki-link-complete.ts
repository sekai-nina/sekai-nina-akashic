import type { ArticleType } from "@prisma/client";

/**
 * 記事エディタの `[[` 補完 (#318)。CodeMirror に依らない純粋関数だけを置く。
 *
 * 本文の `[[タイトル]]` / `[[タイトル|表示名]]` の解決は `footnotes.ts` の
 * `parseBodySegments` が持つ。ここは入力の補助だけ。
 */

/** 補完の候補 1 件。ページ表示時にサーバーから渡す */
export interface WikiLinkCandidate {
  shortId: string;
  title: string;
  type: ArticleType | null;
  draft: boolean;
  unlisted: boolean;
}

/**
 * カーソルより前の同じ行から、書きかけの `[[…` を探す。
 *
 * - 戻り値の `from` は `[[` の直後 (= 置き換え範囲の始まり)。`lineText` 内の位置
 * - `]]` で閉じ済み、`|` で表示名を書いている、`[` / `]` が混ざる場合は補完しない
 */
export function findWikiLinkQuery(lineTextBeforeCursor: string): { from: number; query: string } | null {
  const open = lineTextBeforeCursor.lastIndexOf("[[");
  if (open < 0) return null;
  const query = lineTextBeforeCursor.slice(open + 2);
  if (/[[\]|]/.test(query)) return null;
  return { from: open + 2, query };
}

function normalize(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * 候補を絞って並べる。部分一致で、前方一致 → 一致位置が前 → タイトルが短い順。
 * 空の問い合わせでは全件をタイトル順に返す。
 */
export function rankWikiLinkCandidates(
  candidates: readonly WikiLinkCandidate[],
  query: string,
  limit = 50,
): WikiLinkCandidate[] {
  const q = normalize(query.trim());
  if (!q) return [...candidates].sort((a, b) => a.title.localeCompare(b.title, "ja")).slice(0, limit);
  const hits: { c: WikiLinkCandidate; pos: number }[] = [];
  for (const c of candidates) {
    const pos = normalize(c.title).indexOf(q);
    if (pos >= 0) hits.push({ c, pos });
  }
  hits.sort((a, b) => a.pos - b.pos || a.c.title.length - b.c.title.length || a.c.title.localeCompare(b.c.title, "ja"));
  return hits.slice(0, limit).map((h) => h.c);
}

/**
 * 候補を選んだときに入れる文字列と、カーソル後ろの何文字を置き換えるか。
 *
 * 既存の `[[…]]` の途中で選んだときは、カーソルからタイトルの終わりまでをまとめて置き換える
 * (残すと `[[新]]旧]]` になる)。
 * - `]]` で終わるなら `]]` まで置き換える
 * - `|表示名]]` が続くなら `|` の手前まで置き換え、表示名は残す
 * - `[` / 改行が先に来るなら別物とみなして触らない
 *
 * `textAfterCursor` はカーソルから行末まで。
 */
export function wikiLinkInsertion(title: string, textAfterCursor: string): { insert: string; consumeAfter: number } {
  const m = /^[^[\]|\n]*(\]\]|\|)/.exec(textAfterCursor);
  if (!m) return { insert: `${title}]]`, consumeAfter: 0 };
  if (m[1] === "|") return { insert: title, consumeAfter: m[0].length - 1 };
  return { insert: `${title}]]`, consumeAfter: m[0].length };
}
