import type { ArticleSourceStatus, ArticleType } from "@prisma/client";

import type { ArticleColumns } from "./frontmatter";

/**
 * 取り込み結果が DB の内容と変わっているか。
 *
 * 変わっていない記事を毎回 upsert + ArticleSource 全置換すると、332 件ぶんの
 * 書き込みが無駄に走る。Supabase は従量課金なので、これは金額に直結する
 * (過去に走りっぱなしのスクリプトで egress 70GB 超過の事故がある)。
 *
 * **判定を誤って「変わっていない」と言うと変更が反映されない** ので、
 * 比較対象は Article のカラムと ArticleSource の全フィールドを網羅する。
 */

/** 差分判定に必要な ArticleSource の形 (frontmatter 由来の行だけを渡す) */
export interface ComparableSource {
  assetId: string | null;
  status: ArticleSourceStatus;
  sourceNo: number | null;
  label: string;
  url: string | null;
  date: Date | null;
  originalRef: string | null;
  sortOrder: number;
}

/** 差分判定に必要な Article の形 */
export interface ComparableArticle {
  path: string;
  slug: string | null;
  title: string;
  type: ArticleType | null;
  tags: unknown;
  body: string;
  date: Date | null;
  dateDisplay: string | null;
  dateMode: string | null;
  publishedAt: Date | null;
  articleUpdatedAt: Date | null;
  draft: boolean;
  unlisted: boolean;
  ongoing: boolean;
  lat: number | null;
  lng: number | null;
  frontmatterExtra: unknown;
  sources: ComparableSource[];
}

const time = (d: Date | null | undefined) => (d == null ? null : d.getTime());

/**
 * オブジェクトのキーを再帰的に並べ替える。
 *
 * `frontmatterExtra` は **jsonb** なので、Postgres がキーを (長さ, バイト順) で
 * 並べ替えて保存する。素の `JSON.stringify` で比べると、内容が同じでも
 * 記述順と保存順が違うだけで「変わった」と言い続け、差分スキップが効かない
 * (実測で 332 件中 72 件がキー順の差だけで毎回書き込まれていた)。
 * 配列は順序に意味があるのでそのまま。
 */
function canonicalJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonicalJson(o[k])]));
  }
  return v;
}

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));

export function hasChanged(
  prev: ComparableArticle,
  next: Omit<ArticleColumns, "sources">,
  nextSources: ComparableSource[],
): boolean {
  if (
    prev.path !== next.path ||
    prev.slug !== next.slug ||
    prev.title !== next.title ||
    prev.type !== next.type ||
    prev.body !== next.body ||
    prev.dateDisplay !== next.dateDisplay ||
    prev.dateMode !== next.dateMode ||
    prev.draft !== (next.draft ?? false) ||
    prev.unlisted !== (next.unlisted ?? false) ||
    prev.ongoing !== (next.ongoing ?? false) ||
    prev.lat !== next.lat ||
    prev.lng !== next.lng ||
    time(prev.date) !== time(next.date as Date | null) ||
    time(prev.publishedAt) !== time(next.publishedAt as Date | null) ||
    time(prev.articleUpdatedAt) !== time(next.articleUpdatedAt as Date | null) ||
    // tags は配列で順序に意味があるので素の比較
    JSON.stringify(prev.tags) !== JSON.stringify(next.tags) ||
    !sameJson(prev.frontmatterExtra, next.frontmatterExtra)
  ) {
    return true;
  }

  if (prev.sources.length !== nextSources.length) return true;
  return prev.sources.some((a, i) => {
    const b = nextSources[i];
    return (
      a.assetId !== b.assetId ||
      a.status !== b.status ||
      a.sourceNo !== b.sourceNo ||
      a.label !== b.label ||
      a.url !== b.url ||
      time(a.date) !== time(b.date) ||
      a.originalRef !== b.originalRef ||
      a.sortOrder !== b.sortOrder
    );
  });
}
