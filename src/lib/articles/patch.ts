import * as z from "zod";
import { $Enums } from "@prisma/client";

import { ARTICLE_DATE_MODE_LABELS, ARTICLE_TYPE_LABELS, describeEnum } from "@/lib/utils";

import {
  toArticleEditFormValues,
  type ArticleEditForm,
  type ArticleEditValues,
} from "./edit";

/**
 * 外部 (REST `PATCH /api/v1/articles/:shortId` / MCP `akashic_update_article`) からの
 * 記事の部分更新。
 *
 * 編集 UI と同じ 12 項目を **省略可** で受け、現在値とマージしてフォームの形
 * (`ArticleEditForm`) に落とす。あとは UI と同じ `parseArticleEditForm` → `updateArticle` を
 * 通すので、正規化 (CRLF / 先頭空行 / タグの trim) と変更検出、`dirty` / `editedAt` の
 * 立て方が UI とズレない。
 *
 * 未知のキーは zod の既定どおり除去する (`AssetIntakeSchema` と同じ方針)。
 */

/** "YYYY-MM-DD"。空文字と null は「消す」。暦に無い日付は `parseArticleEditForm` が弾く */
const DateInput = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2})?$/, "YYYY-MM-DD 形式で指定してください")
  .nullable();

/** ラベル定義 (src/lib/utils.ts) を唯一の真実にする。`parseArticleEditForm` の検証と同じ集合 */
const DATE_MODES = Object.keys(ARTICLE_DATE_MODE_LABELS) as [string, ...string[]];

export const ArticleEditPatchSchema = z.object({
  title: z.string().optional().describe("タイトル。空も可 (下書き)"),
  type: z
    .enum($Enums.ArticleType)
    .nullable()
    .optional()
    .describe(`記事種別。${describeEnum(ARTICLE_TYPE_LABELS)}。null で未設定に`),
  tags: z.array(z.string()).optional().describe("タグ。この並びのまま公開サイトに出る (全置換。[] で全部消す)"),
  body: z.string().optional().describe("本文 (frontmatter を除いた Markdown)。出典は ^[n]、記事間リンクは [[タイトル]]"),
  date: DateInput.optional().describe("記事の日付 (YYYY-MM-DD)。null / 空で消す"),
  dateDisplay: z.string().nullable().optional().describe("日付の表示文字列 (例: 2025年春)。null で消す"),
  dateMode: z
    .enum(DATE_MODES)
    .nullable()
    .optional()
    .describe(`日付の扱い。${describeEnum(ARTICLE_DATE_MODE_LABELS)}。null で未設定に`),
  publishedAt: DateInput.optional().describe("公開日 (YYYY-MM-DD)。null / 空で消す"),
  articleUpdatedAt: DateInput.optional().describe("更新日 (YYYY-MM-DD)。本文を直したら今日 (JST) にするのが慣習。null / 空で消す"),
  draft: z.boolean().optional().describe("下書き (公開サイトに出さない)"),
  unlisted: z.boolean().optional().describe("一覧に出さない"),
  ongoing: z.boolean().optional().describe("継続中の出来事"),
});

export type ArticleEditPatch = z.infer<typeof ArticleEditPatchSchema>;

/**
 * 楽観ロックの `updatedAt`。GET が返した ISO 8601 をそのまま返させる。
 * `parseUpdatedAt` で Date に落とす (スキーマを通った値なら null にならない)。
 */
export const UpdatedAtSchema = z
  .string()
  .refine((s) => parseUpdatedAt(s) != null, "ISO 8601 の日時で指定してください")
  .describe("GET が返した updatedAt (ISO 8601)。一致しなければ衝突");

/** ISO 8601 文字列 → Date。解釈できなければ null (`new Date` は無効値で例外を投げず NaN になる) */
export function parseUpdatedAt(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** REST `PATCH` の body。部分更新 + `updatedAt` 必須 */
export const ArticleUpdateRequestSchema = ArticleEditPatchSchema.extend({ updatedAt: UpdatedAtSchema });

/** REST `POST …/apply` の body */
export const ArticleApplyRequestSchema = z.object({ updatedAt: UpdatedAtSchema });

/** 部分更新に 1 項目でも入っているか。空の PATCH は何もしない (dirty も立てない) */
export function hasPatchFields(patch: ArticleEditPatch): boolean {
  return Object.values(patch).some((v) => v !== undefined);
}

/**
 * 現在値に部分更新を重ねてフォームの形にする。
 *
 * 省略 (`undefined`) は「触らない」、`null` は「消す」(フォームの空欄と同じ)。
 * 現在値は `toArticleEditFormValues` でフォームと同じ文字列表現に落としてから重ねるので、
 * 触らなかった項目は UI で開いて保存したときと同じ値になる (= 変更なし扱い)。
 */
export function mergeArticleEditPatch(current: ArticleEditValues, patch: ArticleEditPatch): ArticleEditForm {
  const form = toArticleEditFormValues(current);
  const pick = (v: string | null | undefined, fallback: string): string | null =>
    v === undefined ? fallback : v;
  return {
    title: pick(patch.title, form.title),
    type: pick(patch.type, form.type),
    tags: patch.tags ?? form.tags,
    body: pick(patch.body, form.body),
    date: pick(patch.date, form.date),
    dateDisplay: pick(patch.dateDisplay, form.dateDisplay),
    dateMode: pick(patch.dateMode, form.dateMode),
    publishedAt: pick(patch.publishedAt, form.publishedAt),
    articleUpdatedAt: pick(patch.articleUpdatedAt, form.articleUpdatedAt),
    draft: patch.draft ?? form.draft,
    unlisted: patch.unlisted ?? form.unlisted,
    ongoing: patch.ongoing ?? form.ongoing,
  };
}
