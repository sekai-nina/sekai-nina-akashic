/**
 * 関連記事 (frontmatter の `related`) の読み書き (#319)。
 *
 * `related` は記事タイトルの配列で、モデル化せず `Article.frontmatterExtra.related` に入っている。
 * 公開サイト (sekai-nina-site) は記事下の「関連記事」で最優先に並べ、グラフにも線を引く
 * (`src/utils/related.ts` / `GraphViewLocal.astro`)。並び順はそのまま出る。
 *
 * 実ファイルには `related:\n  -` (= `[null]`) のような空要素が混じる。読むときは文字列以外を落とし、
 * 書き換えるのは中身が変わったときだけにする (触っていない記事に push の差分を出さない)。
 */

/**
 * `frontmatterExtra` から関連記事のタイトルを取り出す。文字列以外を落とし、`normalizeRelated` と
 * 同じく trim・空・重複を落とす (保存時の正規化と揃えないと、触っていない記事が「変わった」ことになる)
 */
export function readRelated(extra: unknown): string[] {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return [];
  const related = (extra as Record<string, unknown>).related;
  if (!Array.isArray(related)) return [];
  return normalizeRelated(related.filter((t): t is string => typeof t === "string"));
}

/** フォームから来た値の正規化。trim して空と重複を落とす (順序は保つ) */
export function normalizeRelated(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    const s = t.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * `frontmatterExtra` の `related` を差し替えた新しいオブジェクトを返す。空ならキーごと消す
 * (公開サイトは `related` が無くても空配列でも同じに扱う)。他のキーは触らない。
 */
export function withRelated(extra: unknown, related: readonly string[]): Record<string, unknown> {
  const base = extra && typeof extra === "object" && !Array.isArray(extra) ? { ...(extra as Record<string, unknown>) } : {};
  if (related.length) base.related = [...related];
  else delete base.related;
  return base;
}

export function sameRelated(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * 本文がタイトル `title` の記事に `[[ ]]` でリンクしているか。
 * `[[題]]` / `[[題|表示]]` / テーブル内の `[[題\|表示]]` を拾う (`footnotes.ts` の解決と同じ形)
 */
export function bodyLinksTo(body: string, title: string): boolean {
  if (!title) return false;
  return body.includes(`[[${title}]]`) || body.includes(`[[${title}|`) || body.includes(`[[${title}\\|`);
}

/** 被リンク 1 件 (記事パネルに出す)。`listArticleBacklinks` が返す */
export interface ArticleBacklink {
  shortId: string;
  title: string;
  draft: boolean;
  /** どこから参照しているか。本文の `[[ ]]` / frontmatter の `related` */
  via: ArticleBacklinkVia[];
}

export type ArticleBacklinkVia = "body" | "related";
