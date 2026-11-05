/**
 * ミーグリの X レポの検索条件を、画面の入力欄と行き来する純粋関数。
 *
 * 入力欄は 1 行 = 1 グループ。行の中は空白区切りで AND、`OR` を挟むと OR、行どうしは OR。
 * クライアント部品からも読むので、ここには重い依存を持ち込まない。
 */

import { buildQuery, type HashtagGroup } from "@/lib/twitter/x-search";

export interface ReportSearch {
  groups: HashtagGroup[];
  extra: string;
}

/**
 * DB の Json を読む。`/repo` や移行で入った行は入力の上限を超えていることがあるので、
 * 形だけを見て、崩れたグループだけを落とす
 */
export function storedGroups(value: unknown): HashtagGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((g): HashtagGroup[] => {
    const { tags, op } = (g ?? {}) as { tags?: unknown; op?: unknown };
    if (!Array.isArray(tags) || (op !== "and" && op !== "or")) return [];
    const clean = tags.filter((t): t is string => typeof t === "string" && t.trim() !== "");
    return clean.length > 0 ? [{ tags: clean, op }] : [];
  });
}

export function formatReportGroups(groups: readonly HashtagGroup[]): string {
  return groups
    .map((g) => g.tags.map((t) => `#${t}`).join(g.op === "or" ? " OR " : " "))
    .join("\n");
}

export type ParsedReportGroups =
  | { ok: true; groups: HashtagGroup[] }
  | { ok: false; error: string };

export function parseReportGroups(text: string): ParsedReportGroups {
  const groups: HashtagGroup[] = [];
  for (const line of text.split("\n")) {
    const tokens = line.split(/[\s,、]+/).filter(Boolean);
    if (tokens.length === 0) continue;

    // 小文字・全角で書いても OR にする (そのままだと #or というタグになり、ほぼ 0 件で気づけない)
    const isOr = (t: string) => /^(or|ｏｒ)$/i.test(t);
    const usesOr = tokens.some(isOr);
    if (usesOr && (isOr(tokens[0]) || isOr(tokens[tokens.length - 1]))) {
      return { ok: false, error: `OR の前後にタグがありません: ${line.trim()}` };
    }
    // AND と OR を 1 行に混ぜると、どちらが先に結合するかが読めない
    if (usesOr && !tokens.every((t, i) => isOr(t) === (i % 2 === 1))) {
      return { ok: false, error: `1 行の中で AND と OR は混ぜられません: ${line.trim()}` };
    }

    const tags = tokens.filter((t) => !isOr(t)).map((t) => t.replace(/^[#＃]+/, ""));
    if (tags.some((t) => !t)) return { ok: false, error: `空のタグがあります: ${line.trim()}` };
    // 除外や括弧はタグにすると別の意味のクエリになる
    if (tags.some((t) => /[-()"':]/.test(t[0]))) {
      return { ok: false, error: `タグにできません。追加条件に書いてください: ${line.trim()}` };
    }
    groups.push({ tags: [...new Set(tags)], op: usesOr ? "or" : "and" });
  }
  return { ok: true, groups };
}

/** 保存される X クエリの下見。条件が空なら null */
export function previewReportQuery(
  groups: HashtagGroup[],
  extra: string,
  options: { excludeRetweets: boolean; langJa: boolean }
): string | null {
  if (groups.length === 0 && !extra.trim()) return null;
  return buildQuery(groups, "or", options.excludeRetweets, options.langJa, extra);
}
