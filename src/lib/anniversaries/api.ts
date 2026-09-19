/**
 * REST (/api/v1/anniversaries) の入力スキーマと返却の射影。
 * 画面 (Server Actions) とは別経路だが domain 関数は同じものを呼ぶ。
 */
import { z } from "zod";
import { isValidDateString, toJstDateOnly } from "@/lib/utils";
import type { AnniversaryRow } from "@/lib/domain/anniversaries";

export const CreateAnniversarySchema = z
  .object({
    date: z.string().refine(isValidDateString, "暦に実在する YYYY-MM-DD で指定してください"),
    title: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    assetId: z.string().min(1).nullable().optional(),
    sourceUrl: z.string().url().max(2000).nullable().optional(),
    articleId: z.string().min(1).nullable().optional(),
    classification: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  })
  .strict();

export const UpdateAnniversarySchema = CreateAnniversarySchema.partial()
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "更新項目がありません" });

/**
 * 公開サイトが使う形。出典はアセットの SourceRecord (url / publisher) を平らにして返し、
 * 手入力の sourceUrl があればそちらを優先する (アセット化されていない公式ページ等)。
 */
export function projectAnniversary(row: AnniversaryRow) {
  const record = row.asset?.sourceRecords[0] ?? null;
  return {
    id: row.id,
    date: row.date,
    monthDay: row.date.slice(5, 10),
    title: row.title,
    description: row.description,
    source: row.sourceUrl || record?.url
      ? {
          url: row.sourceUrl || record?.url || null,
          label: record?.title || row.asset?.title || null,
          publisher: record?.publisher?.trim() || null,
        }
      : null,
    asset: row.asset
      ? {
          id: row.asset.id,
          title: row.asset.title,
          kind: row.asset.kind,
          date: toJstDateOnly(row.asset.canonicalDate),
        }
      : null,
    article: row.article
      ? { id: row.article.id, shortId: row.article.shortId, path: row.article.path, slug: row.article.slug, title: row.article.title }
      : null,
    classification: row.classification,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
