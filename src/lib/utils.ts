import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { TextType } from "@prisma/client";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function normalizeText(text: string): string {
  return text
    .replace(/\{\{IMG:[a-zA-Z0-9_-]+\}\}/g, "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

/**
 * 日時を **JST 壁時計の "YYYY-MM-DD"** にする。
 *
 * このプロダクトの日付ドメインは日本時間。ところが DB には 2 つの規約が
 * 混在していて、素の UTC 日付で突き合わせると 1 日ずれる:
 *
 * | 列 | 日付のみの値の格納 |
 * |---|---|
 * | `Asset.canonicalDate` | JST 深夜 (= 15:00 UTC 前日) |
 * | `Article.date` / `ArticleSource.date` | UTC 深夜 |
 *
 * 日付どうしを比較するときは必ずこれを通す。
 */
export function jstDayString(date: Date): string {
  return new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, length) + "…";
}

export function formatDate(date: Date | string | null, includeTime = false): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (includeTime) {
    return d.toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export const ASSET_KIND_LABELS: Record<string, string> = {
  image: "画像",
  video: "動画",
  audio: "音声",
  text: "テキスト",
  document: "ドキュメント",
  other: "その他",
};

export const ASSET_STATUS_LABELS: Record<string, string> = {
  inbox: "Inbox",
  triaging: "整理中",
  organized: "整理済み",
  archived: "アーカイブ",
};

export const TRUST_LEVEL_LABELS: Record<string, string> = {
  unverified: "未検証",
  low: "低",
  medium: "中",
  high: "高",
  official: "公式",
};

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  person: "人物",
  place: "場所",
  source: "出典",
  event: "イベント",
  tag: "タグ",
};

export const RELATION_TYPE_LABELS: Record<string, string> = {
  parent_child: "親子",
  derived_from: "派生元",
  reference: "関連",
  same_content: "同一コンテンツ",
};

// 表記は sekai-nina-site の src/utils/category.ts (getTypeLabel) に合わせる。
// 公開サイトと呼び方がズレると同じものを指しているか分からなくなるため。
// quiz は sekai-nina-site の ArticleType に無い (記事は 3 本存在する)。
export const ARTICLE_TYPE_LABELS: Record<string, string> = {
  attribute: "スナップ",
  event: "出来事",
  quote: "言葉",
  column: "コラム",
  item: "物",
  quiz: "クイズ",
};

export const ARTICLE_SOURCE_STATUS_LABELS: Record<string, string> = {
  applied: "反映済み",
  pending: "未反映",
  unresolved: "未解決",
};

/**
 * 未検証の文字列を TextType に絞り込む。
 *
 * 抜粋の textType は DOM の data 属性経由でクライアントから来るため、
 * Server Action の入り口で必ずこれを通す (型アサーションで押し込まない)。
 * enum に無い値は undefined にして落とす。
 */
export function toTextType(v: unknown): TextType | undefined {
  if (typeof v !== "string") return undefined;
  return (Object.values(TextType) as string[]).includes(v) ? (v as TextType) : undefined;
}

// ============================================================
// JST の暦日境界
// ============================================================

/** 日本には DST が無いので固定オフセットでよい */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 「YYYY-MM-DD」を UTC 00:00 として解釈した Date を、**JST のその暦日が始まる実時刻**に直す。
 *
 * 画面や API から来る日付は `new Date("2026-03-24")` = 2026-03-24T00:00:00Z で、
 * これをそのまま比較すると JST 0〜9 時のデータが隣の日に落ちる
 * (実測で全体の 5% 前後がずれる。`src/lib/domain/coverage.ts` のコメント参照)。
 *
 * 列側を `AT TIME ZONE` で変換する手もあるが、それだと索引が効かなくなるので
 * **境界値のほうをずらす**。比較は生の列に対して行う。
 */
export function jstDayStart(dateOnlyUtc: Date): Date {
  return new Date(dateOnlyUtc.getTime() - JST_OFFSET_MS);
}

/** 同上。JST のその暦日の**翌日 0 時**（= 排他的上限）を返す。 */
export function jstDayEndExclusive(dateOnlyUtc: Date): Date {
  return new Date(dateOnlyUtc.getTime() + DAY_MS - JST_OFFSET_MS);
}
