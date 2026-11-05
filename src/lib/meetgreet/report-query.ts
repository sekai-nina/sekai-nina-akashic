/**
 * ミーグリの X レポの検索条件を、画面の入力欄と行き来する純粋関数。
 *
 * 入力欄は 1 行 = 1 グループ。行の中は空白区切りで AND、`OR` を挟むと OR、行どうしは OR。
 * クライアント部品からも読むので、ここには重い依存を持ち込まない。
 */

import { z } from "zod";
import { buildQuery, type HashtagGroup } from "@/lib/twitter/x-search";

const MAX_GROUPS = 20;
const MAX_TAGS_PER_GROUP = 10;
const MAX_TAG_LENGTH = 50;
const MAX_EXTRA_LENGTH = 400;
export const MAX_PRESET_NAME_LENGTH = 50;

const GroupSchema = z.object({
  tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).min(1).max(MAX_TAGS_PER_GROUP),
  op: z.enum(["and", "or"]),
});

export const ReportSearchSchema = z
  .object({
    groups: z.array(GroupSchema).max(MAX_GROUPS),
    extra: z.string().trim().max(MAX_EXTRA_LENGTH),
  })
  .refine((v) => v.groups.length > 0 || v.extra.length > 0, {
    message: "ハッシュタグか追加条件を 1 つ以上入れてください",
  });
export type ReportSearch = z.infer<typeof ReportSearchSchema>;

export const ReportPresetSchema = z.object({
  /** 指定すると上書き、無ければ新規 */
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, "プリセットの名前を入れてください").max(MAX_PRESET_NAME_LENGTH),
  search: ReportSearchSchema,
});

/** DB の Json を読む。形が崩れていたら空 (入力欄が空になるだけで、画面は落とさない) */
export function storedGroups(value: unknown): HashtagGroup[] {
  const parsed = z.array(GroupSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
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

    const usesOr = tokens.includes("OR");
    // AND と OR を 1 行に混ぜると、どちらが先に結合するかが読めない
    if (usesOr && !tokens.every((t, i) => (t === "OR") === (i % 2 === 1))) {
      return { ok: false, error: `1 行の中で AND と OR は混ぜられません: ${line.trim()}` };
    }
    if (usesOr && tokens.length % 2 === 0) {
      return { ok: false, error: `OR の後ろにタグがありません: ${line.trim()}` };
    }

    const tags = tokens.filter((t) => t !== "OR").map((t) => t.replace(/^[#＃]+/, ""));
    if (tags.some((t) => !t)) return { ok: false, error: `空のタグがあります: ${line.trim()}` };
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
