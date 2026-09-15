import { API_APPLY_MAX_CLASSIFICATION } from "@/lib/articles/apply";
import { frontmatterExtraKeys, toDateInputValue } from "@/lib/articles/edit";
import { isAboveClearance } from "@/lib/classification";
import { ArticleSourceStatus } from "@prisma/client";

import type { getArticleByShortId, listArticles } from "./articles";

/**
 * 記事を API キー経路 (REST `/api/v1/articles` と MCP の記事ツール) に返すときの形。
 *
 * 2 経路で同じ JSON を返すためにここに 1 つだけ置く (`asset-intake.ts` と同じく REST / MCP 共有の
 * 層なので `domain/` に置く)。
 *
 * - 日付の frontmatter 列 (date / publishedAt / articleUpdatedAt / 出典の date) は "YYYY-MM-DD" に
 *   落とす — PATCH の入力と同じ形にして、AI が読んだ値をそのまま書き戻せるようにする。編集 UI の
 *   `toDateInputValue` と同じ規則 (深夜でない値も暦日に丸める。#91-1)。`updatedAt` / `editedAt` は
 *   楽観ロックに使うので ISO のまま
 * - **`API_APPLY_MAX_CLASSIFICATION` より上の pending 行は返さない。** API キーからはどのみち apply
 *   できず (`applyArticleSource` の上限)、抜粋だけ見せると「apply できない抜粋を本文に貼る」経路になる
 *   (本文の書き込みには classification のガードが無い)。一覧の `pendingCount` も `listArticles` に
 *   同じ上限を渡して揃える
 * - `frontmatterExtra` の中身は出さない (キー名だけ)。API から触れない列なので、見せると
 *   「PATCH で書けるはず」と誤解させる
 */

type ListedArticle = Awaited<ReturnType<typeof listArticles>>["items"][number];
type ArticleDetailRow = NonNullable<Awaited<ReturnType<typeof getArticleByShortId>>>;
type ArticleSourceRowWithAsset = ArticleDetailRow["sources"][number];

const dateOnly = (d: Date | null) => toDateInputValue(d) || null;

/** API キー経路に見せてよい出典行か。上限より上の pending 行だけ落とす (applied / unresolved は public のみ) */
export function isApiVisibleSource(s: Pick<ArticleSourceRowWithAsset, "status" | "classification">): boolean {
  return s.status !== ArticleSourceStatus.pending || !isAboveClearance(s.classification, API_APPLY_MAX_CLASSIFICATION);
}

export function toArticleSummary(a: ListedArticle) {
  return {
    shortId: a.shortId,
    path: a.path,
    title: a.title,
    type: a.type,
    tags: a.tags,
    publishedAt: dateOnly(a.publishedAt),
    articleUpdatedAt: dateOnly(a.articleUpdatedAt),
    draft: a.draft,
    unlisted: a.unlisted,
    dirty: a.dirty,
    editedAt: a.editedAt,
    updatedAt: a.updatedAt,
    sourceCount: a.sourceCount,
    pendingCount: a.pendingCount,
  };
}

export function toArticleSourceDetail(s: ArticleSourceRowWithAsset) {
  return {
    id: s.id,
    status: s.status,
    sourceNo: s.sourceNo,
    label: s.label,
    url: s.url,
    date: dateOnly(s.date),
    classification: s.classification,
    excerpt: s.excerpt,
    excerptType: s.excerptType,
    excerptStart: s.excerptStart,
    excerptEnd: s.excerptEnd,
    note: s.note,
    sortOrder: s.sortOrder,
    originalRef: s.originalRef,
    asset: s.asset
      ? {
          id: s.asset.id,
          title: s.asset.title,
          kind: s.asset.kind,
          canonicalDate: s.asset.canonicalDate,
          classification: s.asset.classification,
        }
      : null,
  };
}

export function toArticleDetail(a: ArticleDetailRow) {
  return {
    shortId: a.shortId,
    path: a.path,
    slug: a.slug,
    title: a.title,
    type: a.type,
    tags: a.tags,
    body: a.body,
    date: dateOnly(a.date),
    dateDisplay: a.dateDisplay,
    dateMode: a.dateMode,
    publishedAt: dateOnly(a.publishedAt),
    articleUpdatedAt: dateOnly(a.articleUpdatedAt),
    draft: a.draft,
    unlisted: a.unlisted,
    ongoing: a.ongoing,
    frontmatterExtraKeys: frontmatterExtraKeys(a),
    dirty: a.dirty,
    editedAt: a.editedAt,
    lastPushedAt: a.lastPushedAt,
    updatedAt: a.updatedAt,
    sources: a.sources.filter(isApiVisibleSource).map(toArticleSourceDetail),
  };
}
