import { ClearanceLevel } from "@prisma/client";

import { footnoteRefsInBody } from "./footnotes";

/**
 * pending → applied の遷移 (`applyArticleSource`) で使う純粋関数。
 *
 * 遷移は「出典を公開リポジトリの frontmatter に載せる」操作なので、採番の規則を
 * ここに切り出して vitest で押さえる (domain 側は認可と DB だけ)。
 */

/**
 * API キー経路 (REST / MCP) が applied = public に下げてよい classification の上限。
 *
 * `docs/api.md` / `docs/mcp.md` は「API キーからの機密レベルの引き下げは不可」としている
 * (プロンプトインジェクション 1 回で機密を公開扱いに落とせないように)。pending → applied は
 * その例外で、**internal 以下の出典だけ**機械が公開を決めてよい。confidential 以上は
 * 画面から人間が押す。
 */
export const API_APPLY_MAX_CLASSIFICATION: ClearanceLevel = ClearanceLevel.internal;

/**
 * 新しく applied にする行の脚注番号。
 *
 * `max(既存の番号 ∪ 本文が参照している ^[n]) + 1`。本文側も見るのは、出典の無い `^[n]`
 * (宛先の無い脚注) が残っている記事で、新しい出典がその番号に黙って結びつくのを防ぐため
 * (本番では 0 件だが、編集 UI から書けるようになったので起こりうる)。
 * 番号が 1 つも無ければ 1。
 */
export function nextSourceNo(existing: readonly (number | null)[], body: string): number {
  let max = 0;
  for (const n of existing) if (n != null && n > max) max = n;
  for (const n of footnoteRefsInBody(body)) if (n > max) max = n;
  return max + 1;
}

/**
 * 新しく applied にする行の `sortOrder`。非 pending 行の末尾に付ける。
 *
 * 取り込みは 0.. を振り直し、`addAssetToArticle` は pending を含む max + 1 を振るので、
 * 紐づけ時の値をそのまま使うと後から紐づけた行が先に applied になったとき frontmatter の
 * 並びが脚注番号順にならない。apply 時に非 pending 行だけで採り直す
 * (`buildFrontmatter` は sortOrder → sourceNo で並べる)。
 */
export function nextSortOrder(existing: readonly number[]): number {
  let max = -1;
  for (const n of existing) if (n > max) max = n;
  return max + 1;
}
