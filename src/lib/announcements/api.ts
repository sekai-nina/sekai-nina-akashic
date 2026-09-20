/**
 * REST (/api/v1/announcements) の入力スキーマと返却の射影。
 * 画面 (Server Actions) とは別経路だが domain 関数は同じものを呼ぶ。
 */
import { z } from "zod";
import type { AnnouncementRow } from "@/lib/domain/announcements";

const urlField = z
  .string()
  .max(2000)
  .refine((v) => /^(\/[^/]|https?:\/\/)/.test(v), "/ で始まるサイト内パスか http(s) の URL")
  .nullable()
  .optional();

export const CreateAnnouncementSchema = z
  .object({
    title: z.string().min(1).max(120),
    body: z.string().max(5000).optional(),
    kind: z.enum(["feature", "article", "info"]).optional(),
    url: urlField,
    /** ISO 8601。null / 省略で下書き。"now" で今 */
    publishedAt: z.union([z.literal("now"), z.string().datetime({ offset: true })]).nullable().optional(),
  })
  .strict();

export const UpdateAnnouncementSchema = CreateAnnouncementSchema.partial()
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "更新項目がありません" });

export function parsePublishedAt(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return v === "now" ? new Date() : new Date(v);
}

/** 公開サイト・stats Worker が使う形。本文は Markdown と描画済み HTML の両方を返す */
export function projectAnnouncement(row: AnnouncementRow, bodyHtml: string) {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    body: row.body,
    bodyHtml,
    url: row.url,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
