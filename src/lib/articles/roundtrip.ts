import { buildFrontmatter, parseArticle, serializeArticle, toArticleColumns } from "./frontmatter";

/**
 * Markdown 1 本を **取り込みと同じ経路で** 往復させる。
 *
 *   ファイル → parseArticle → toArticleColumns (DB カラム) → buildFrontmatter → serializeArticle
 *
 * push (#46) が通るのと同じ変換をそのまま並べたもの。テストがここを通ることで、
 * 「テストは緑だが本番の取り込みは別の規則で動く」状態を防ぐ。
 */
export function roundtrip(raw: string, path = "test.md"): string {
  const cols = toArticleColumns(parseArticle(raw), path);
  return serializeArticle(buildFrontmatter(cols), cols.body);
}
