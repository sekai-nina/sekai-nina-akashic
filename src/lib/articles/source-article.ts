/**
 * 記事を出典にする (#320)。純粋関数だけを置く (記事パネルのクライアントからも使う)。
 *
 * frontmatter には `url: /articles/<shortId>` だけを書き、label は書かない。公開サイト
 * (sekai-nina-site の `[...slug].astro` の `resolveInternalArticle`) は `http` で始まらない url を
 * 記事として解決し、label が無ければその時のタイトルを出すので、参照先を改題しても追従する。
 * shortId は変わらないので url も変わらない。
 */

const PREFIX = "/articles/";
/** shortId は 7 桁 base62 (`src/lib/articles/create.ts`) */
const SHORT_ID = /^[0-9A-Za-z]{7}$/;

/** 記事出典の url */
export function articleSourceUrl(shortId: string): string {
  return `${PREFIX}${shortId}`;
}

/** 記事出典の url から shortId を取り出す。記事出典の形でなければ null */
export function shortIdFromArticleSourceUrl(url: string | null | undefined): string | null {
  if (!url?.startsWith(PREFIX)) return null;
  const id = url.slice(PREFIX.length);
  return SHORT_ID.test(id) ? id : null;
}

/** 保存前に予約した記事出典 (編集フォームの hidden input で送る) */
export interface ReservedArticleSource {
  /** 参照先の記事 */
  shortId: string;
  /** 本文に入れた `^[n]` の n */
  sourceNo: number;
}

/**
 * フォームから来た予約の JSON を検証する。形が違えば null (改ざん・古いフォーム)。
 * 番号の重複はここで弾く (既存の出典との重複は保存時に DB で確かめる)
 */
export function parseReservedArticleSources(raw: string | null): ReservedArticleSource[] | null {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const out: ReservedArticleSource[] = [];
  const nos = new Set<number>();
  for (const item of v) {
    if (!item || typeof item !== "object") return null;
    const { shortId, sourceNo } = item as Record<string, unknown>;
    if (typeof shortId !== "string" || !SHORT_ID.test(shortId)) return null;
    if (typeof sourceNo !== "number" || !Number.isInteger(sourceNo) || sourceNo < 1 || nos.has(sourceNo)) return null;
    nos.add(sourceNo);
    out.push({ shortId, sourceNo });
  }
  return out;
}
