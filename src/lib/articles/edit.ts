import type { ArticleType } from "@prisma/client";

import { ARTICLE_DATE_MODE_LABELS } from "@/lib/utils";

import { ARTICLE_TYPES, formatFrontmatterDate, parseFrontmatterDate } from "./frontmatter";

/**
 * 記事編集フォーム (/articles/[shortId]/edit) の値 ↔ Article のカラム。
 *
 * ここは純粋関数だけにして vitest で押さえる (Server Action 側は認可と DB だけ)。
 * 取り込み (`toArticleColumns`) と同じ規則で値を作らないと、編集して保存しただけで
 * push に差分が出る。日付は `parseFrontmatterDate` (UTC 深夜の date-only)、本文の
 * 先頭空行は `parseArticle` と同じく落とす。
 */

/** フォームで編集できるカラム。slug / lat / lng / path は触らせない (実データで使われていない) */
export interface ArticleEditValues {
  title: string;
  type: ArticleType | null;
  tags: string[];
  body: string;
  date: Date | null;
  dateDisplay: string | null;
  /** null / "single" / "range" (公開サイトの enum) */
  dateMode: string | null;
  publishedAt: Date | null;
  articleUpdatedAt: Date | null;
  draft: boolean;
  unlisted: boolean;
  ongoing: boolean;
}

export type ArticleEditField = keyof ArticleEditValues;

/** FormData から取り出した生の値。チェックボックスは未チェックだとキー自体が来ない */
export interface ArticleEditForm {
  title: string | null;
  type: string | null;
  /** `formData.getAll("tags")`。チップ 1 つにつき hidden input 1 つ */
  tags: string[];
  body: string | null;
  /** `<input type="date">` の "YYYY-MM-DD"。空なら "" */
  date: string | null;
  dateDisplay: string | null;
  dateMode: string | null;
  publishedAt: string | null;
  articleUpdatedAt: string | null;
  draft: boolean;
  unlisted: boolean;
  ongoing: boolean;
}

export type ParsedArticleEditForm =
  | { ok: true; values: ArticleEditValues }
  | { ok: false; errors: Partial<Record<ArticleEditField, string>> };

/** ラベル定義 (src/lib/utils.ts) を唯一の真実にする。select の選択肢と検証がズレないように */
const DATE_MODES: ReadonlySet<string> = new Set(Object.keys(ARTICLE_DATE_MODE_LABELS));

/**
 * 本文の上限 (文字数)。実記事の最大は 14,449 文字なので余裕を大きく取る。
 * 保存だけでなくプレビュー (remark + KaTeX を回す) にも掛け、誰でも重い描画を投げられる経路を塞ぐ
 */
export const BODY_MAX_LENGTH = 200_000;

/**
 * 本文の正規化。
 *
 * - `\r\n` → `\n`: form 送信の textarea は仕様で CRLF になる。そのまま保存すると
 *   push で全行差分になる (実ファイルに CRLF は 0 本)
 * - 先頭の空行を落とす: `parseArticle` と同じ。`serializeArticle` が `---\n\n` を付け直すので、
 *   残すと DB の本文がファイルと永久に食い違う
 * - 末尾は触らない: 実ファイルは末尾改行なし 40 本 / 2 個以上 120 本で揃っておらず、
 *   ここで揃えると触っていない記事に差分が出る
 */
export function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/^\n+/, "");
}

const str = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};

/**
 * 日付欄。空は null、それ以外は date-only として解釈する。
 *
 * `<input type="date">` は "YYYY-MM-DD" しか出さないが、Server Action は任意の文字列を
 * 受け取れるので形式も見る。`parseFrontmatterDate` は暦に無い日付 (2/30) を null にするので、
 * 「入力があるのに null」を無効として扱う (黙って消えるのが一番まずい)。
 */
function parseDateField(v: string | null | undefined): { ok: true; value: Date | null } | { ok: false } {
  const s = str(v);
  if (s == null) return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false };
  const d = parseFrontmatterDate(s);
  return d ? { ok: true, value: d } : { ok: false };
}

/** タグは trim して空と重複を落とす (順序は保つ。frontmatter の並びがそのまま公開サイトに出る) */
export function normalizeTags(raw: string[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    const s = t.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function parseArticleEditForm(form: ArticleEditForm): ParsedArticleEditForm {
  const errors: Partial<Record<ArticleEditField, string>> = {};

  // タイトルは空を許す。実記事に空タイトルの下書きがあり (公開サイトは「無題」として扱う)、
  // 必須にするとその記事を開いて保存できなくなる
  const title = str(form.title) ?? "";

  const body = normalizeBody(form.body ?? "");
  if (body.length > BODY_MAX_LENGTH) errors.body = `本文が長すぎます (${BODY_MAX_LENGTH.toLocaleString("ja-JP")} 文字まで)`;

  const typeRaw = str(form.type);
  if (typeRaw != null && !ARTICLE_TYPES.has(typeRaw)) errors.type = "種別が不正です";

  const dateModeRaw = str(form.dateMode);
  if (dateModeRaw != null && !DATE_MODES.has(dateModeRaw)) errors.dateMode = "日付の扱いが不正です";

  const date = parseDateField(form.date);
  if (!date.ok) errors.date = "日付が不正です";
  const publishedAt = parseDateField(form.publishedAt);
  if (!publishedAt.ok) errors.publishedAt = "公開日が不正です";
  const articleUpdatedAt = parseDateField(form.articleUpdatedAt);
  if (!articleUpdatedAt.ok) errors.articleUpdatedAt = "更新日が不正です";

  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    values: {
      title,
      type: typeRaw as ArticleType | null,
      tags: normalizeTags(form.tags),
      body,
      date: date.ok ? date.value : null,
      dateDisplay: str(form.dateDisplay),
      dateMode: dateModeRaw,
      publishedAt: publishedAt.ok ? publishedAt.value : null,
      articleUpdatedAt: articleUpdatedAt.ok ? articleUpdatedAt.value : null,
      draft: form.draft,
      unlisted: form.unlisted,
      ongoing: form.ongoing,
    },
  };
}

/** モデル外の frontmatter (featured_quotes / locations / dossier 等) のキー。表示専用 */
export function frontmatterExtraKeys(article: { frontmatterExtra: unknown }): string[] {
  const extra = article.frontmatterExtra;
  return extra && typeof extra === "object" && !Array.isArray(extra) ? Object.keys(extra) : [];
}

/** Article の行 (Prisma の select 結果) をフォームの値に落とす。`tags` は Json なので文字列に揃える */
export function toArticleEditValues(article: {
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
}): ArticleEditValues {
  return {
    title: article.title,
    type: article.type,
    tags: Array.isArray(article.tags) ? (article.tags as unknown[]).map(String) : [],
    body: article.body,
    date: article.date,
    dateDisplay: article.dateDisplay,
    dateMode: article.dateMode,
    publishedAt: article.publishedAt,
    articleUpdatedAt: article.articleUpdatedAt,
    draft: article.draft,
    unlisted: article.unlisted,
    ongoing: article.ongoing,
  };
}

const time = (d: Date | null) => (d == null ? null : d.getTime());

/**
 * 変わったカラムを列挙する。空なら保存しない (dirty / editedAt を立てない)。
 *
 * 「変わっていない」と誤ると編集が消えるので、フィールドは型で網羅する
 * (`ArticleEditValues` にキーを足すとここがコンパイルエラーになる)。
 */
export function diffArticleEdit(prev: ArticleEditValues, next: ArticleEditValues): ArticleEditField[] {
  const same: Record<ArticleEditField, boolean> = {
    title: prev.title === next.title,
    type: prev.type === next.type,
    // 順序に意味がある (公開サイトにこの並びで出る) ので素の比較
    tags: JSON.stringify(prev.tags) === JSON.stringify(next.tags),
    body: prev.body === next.body,
    date: time(prev.date) === time(next.date),
    dateDisplay: prev.dateDisplay === next.dateDisplay,
    dateMode: prev.dateMode === next.dateMode,
    publishedAt: time(prev.publishedAt) === time(next.publishedAt),
    articleUpdatedAt: time(prev.articleUpdatedAt) === time(next.articleUpdatedAt),
    draft: prev.draft === next.draft,
    unlisted: prev.unlisted === next.unlisted,
    ongoing: prev.ongoing === next.ongoing,
  };
  return (Object.keys(same) as ArticleEditField[]).filter((k) => !same[k]);
}

/** フォームの初期値用。Date は `<input type="date">` の "YYYY-MM-DD" に */
export function toDateInputValue(d: Date | null): string {
  return formatFrontmatterDate(d)?.slice(0, 10) ?? "";
}

/** クライアント部品に渡す初期値。Date を持たせず、`<input>` にそのまま入る形にする */
export interface ArticleEditFormValues {
  title: string;
  type: string;
  tags: string[];
  body: string;
  date: string;
  dateDisplay: string;
  dateMode: string;
  publishedAt: string;
  articleUpdatedAt: string;
  draft: boolean;
  unlisted: boolean;
  ongoing: boolean;
}

export function toArticleEditFormValues(values: ArticleEditValues): ArticleEditFormValues {
  return {
    title: values.title,
    type: values.type ?? "",
    tags: values.tags,
    body: values.body,
    date: toDateInputValue(values.date),
    dateDisplay: values.dateDisplay ?? "",
    dateMode: values.dateMode ?? "",
    publishedAt: toDateInputValue(values.publishedAt),
    articleUpdatedAt: toDateInputValue(values.articleUpdatedAt),
    draft: values.draft,
    unlisted: values.unlisted,
    ongoing: values.ongoing,
  };
}
