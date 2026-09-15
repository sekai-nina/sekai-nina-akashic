import { ArticleSourceStatus } from "@prisma/client";

import {
  parseArticle,
  renderArticleMarkdown,
  toArticleColumns,
  toArticleSourceRow,
  type ArticleSourceEntry,
  type ArticleSourceRow,
} from "./frontmatter";

/**
 * 取り込みの照合を DB 無しで真似る。
 *
 * ref があれば「Asset が実在して applied」、無ければ「照合できず unresolved」と
 * みなす。どちらも push 時の ref は `assetId ?? originalRef` で元の値に戻るので、
 * 往復の検証には十分 (実際の照合結果は取り込み CLI が決める)。
 */
export function resolveOffline(entries: ArticleSourceEntry[]): ArticleSourceRow[] {
  return entries.map((e, i) =>
    toArticleSourceRow(
      e,
      e.ref
        ? { assetId: e.ref, status: ArticleSourceStatus.applied }
        : { assetId: null, status: ArticleSourceStatus.unresolved },
      i,
    ),
  );
}

/**
 * Markdown 1 本を **取り込みと同じ経路で** 往復させる。
 *
 *   ファイル → parseArticle → toArticleColumns (DB カラム) → toArticleSourceRow (ArticleSource 行)
 *          → renderArticleMarkdown (buildFrontmatter + serializeArticle)
 *
 * push (#46) が通るのと同じ変換をそのまま並べたもの。テストがここを通ることで、
 * 「テストは緑だが本番の取り込みは別の規則で動く」状態を防ぐ。
 */
export function roundtrip(raw: string, path = "test.md"): string {
  const cols = toArticleColumns(parseArticle(raw), path);
  return renderArticleMarkdown({ ...cols, sources: resolveOffline(cols.sources) }).markdown;
}
