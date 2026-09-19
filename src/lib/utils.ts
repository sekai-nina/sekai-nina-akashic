import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { CandidateGroupKind } from "@/lib/meetgreet/candidates";
import {
  TextType,
  type ArticleType,
  type JobRunStatus,
  type LlmProvider,
  type LlmUsageSource,
  type MeetGreetFormat,
  type PlaceKind,
  type StatusLevel,
} from "@prisma/client";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 本文中の画像プレースホルダ `{{IMG:<assetId>}}`。取り込み時に本文へ埋め込まれ、
 * 表示側 (`RichTextContent`) が画像に置き換える。検索・抜粋では文字列として除く
 */
export const IMG_PLACEHOLDER_RE = /\{\{IMG:[a-zA-Z0-9_-]+\}\}/g;

/** 画像プレースホルダを除いた文字列 (抜粋・クリップの保存形) */
export function stripImagePlaceholders(text: string): string {
  return text.replace(IMG_PLACEHOLDER_RE, "");
}

export function normalizeText(text: string): string {
  return stripImagePlaceholders(text)
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

/**
 * 日時を JST の壁時計で表示する。
 *
 * **timeZone を必ず指定する。** 省略するとサーバの TZ に従うため、
 * ローカル (Mac / JST) と Vercel (UTC) で違う日付が出る。とくに
 * `Asset.canonicalDate` は日付のみの値を JST 深夜 (= 15:00 UTC 前日) で
 * 持つので、UTC で描画すると **1 日前** になる (実測で 2642 件が該当)。
 * ローカルでは正しく見えるので気づけない。
 */
export function formatDate(date: Date | string | null, includeTime = false): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  if (includeTime) {
    return d.toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
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

/** エンティティ種別のチップ配色 (一覧・詳細・クリップで共通) */
export const ENTITY_TYPE_BADGE: Record<string, string> = {
  person: "bg-purple-100 text-purple-800 border-purple-200",
  place: "bg-green-100 text-green-800 border-green-200",
  source: "bg-orange-100 text-orange-800 border-orange-200",
  event: "bg-blue-100 text-blue-800 border-blue-200",
  tag: "bg-slate-100 text-slate-700 border-slate-200",
};

// 表記は sekai-nina-site の聖地マップ (src/utils/places.ts KIND_LABELS) に合わせる。
export const PLACE_KIND_LABELS: Record<PlaceKind, string> = {
  food: "グルメ",
  leisure: "レジャー",
  scenery: "寺社・公園・景色",
  venue: "会場・放送局",
  shop: "店・施設",
};

/** ミーグリの形式。「ミーグリ」を後ろに付けて使う (記事・画面では略称のオンミ / リアミを使わない) */
export const MEETGREET_FORMAT_LABELS: Record<MeetGreetFormat, string> = {
  online: "オンライン",
  real: "リアル",
};

/** ドシエ名など内部向けの略称 (手作業時代の `2026-08-09 通常オンミ` に合わせる) */
export const MEETGREET_FORMAT_SHORT_LABELS: Record<MeetGreetFormat, string> = {
  online: "オンミ",
  real: "リアミ",
};

/** 素材候補のグループ */
export const MEETGREET_CANDIDATE_GROUP_LABELS: Record<CandidateGroupKind, string> = {
  blog: "ブログ",
  staff: "ひなたぼっこ日記",
  talk: "トーク",
  other: "その他",
};

export const RELATION_TYPE_LABELS: Record<string, string> = {
  parent_child: "親子",
  derived_from: "派生元",
  reference: "関連",
  same_content: "同一コンテンツ",
};

// 表記は sekai-nina-site の src/utils/category.ts (getTypeLabel) に合わせる。
// 公開サイトと呼び方がズレると同じものを指しているか分からなくなるため。
// 値の集合は sekai-nina-site の enum と同じ (prisma/schema.prisma の ArticleType 参照)。
export const ARTICLE_TYPE_LABELS: Record<ArticleType, string> = {
  attribute: "スナップ",
  event: "出来事",
  quote: "言葉",
  column: "コラム",
  item: "物",
};

/**
 * enum の説明文を `*_LABELS` から生成する (`attribute=属性 / event=出来事 …`)。
 * API / MCP のスキーマの describe に使う。直書きすると画面表示とズレる
 */
export function describeEnum(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(" / ");
}

export const ARTICLE_SOURCE_STATUS_LABELS: Record<string, string> = {
  applied: "反映済み",
  pending: "未反映",
  unresolved: "未解決",
};

/** frontmatter の date_mode。公開サイト (src/content/config.ts) の enum と同じ値。
 *  取りうる値の唯一の定義で、編集フォームの検証 (src/lib/articles/edit.ts) もここから導く */
export const ARTICLE_DATE_MODE_LABELS: Record<string, string> = {
  single: "単日",
  range: "期間",
};

/** 記事の真偽フラグ (frontmatter の draft / unlisted / ongoing) */
export const ARTICLE_FLAG_LABELS = {
  draft: "下書き",
  unlisted: "限定公開",
  ongoing: "進行中",
} as const;

/** 状態バッジの配色。/status と /costs で共有する */
export const STATUS_LEVEL_BADGE: Record<StatusLevel, string> = {
  ok: "bg-emerald-100 text-emerald-700",
  warn: "bg-amber-100 text-amber-700",
  error: "bg-red-100 text-red-700",
  unknown: "bg-slate-100 text-slate-500",
};

/** パイプライン監視 (/status) のチェック状態 */
export const STATUS_LEVEL_LABELS: Record<StatusLevel, string> = {
  ok: "正常",
  warn: "注意",
  error: "異常",
  unknown: "不明",
};

/** /status のチェックのグループ */
export const CHECK_GROUP_LABELS = {
  collect: "収集",
  process: "加工",
  articles: "記事",
  workers: "外部ワーカー",
  costs: "コスト",
  system: "akashic 自身",
} as const;

export type CheckGroup = keyof typeof CHECK_GROUP_LABELS;

/** グループの表示順 (= CHECK_GROUP_LABELS の定義順) */
export const CHECK_GROUPS = Object.keys(CHECK_GROUP_LABELS) as CheckGroup[];

/** LLM のプロバイダ */
export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google (Gemini)",
};

/**
 * 残高を補充する画面。/costs の「補充する」から開く。
 *
 * Gemini だけ**課金画面への安定した直リンクが無い**ので AI Studio のトップに送る
 * (残高は Dashboard → Usage and Limits に出る)。URL は各社の都合で変わるので、
 * 飛んだ先が違っていたらここを直す。
 */
export const LLM_PROVIDER_BILLING_URLS: Record<LlmProvider, string> = {
  openai: "https://platform.openai.com/settings/organization/billing/overview",
  anthropic: "https://platform.claude.com/settings/billing",
  google: "https://aistudio.google.com/",
};

/** LLM の利用量の出どころ */
export const LLM_USAGE_SOURCE_LABELS: Record<LlmUsageSource, string> = {
  reported: "自己申告",
  provider: "プロバイダ",
};

/** ハートビート (JobRun) の結果 */
export const JOB_RUN_STATUS_LABELS: Record<JobRunStatus, string> = {
  ok: "成功",
  error: "失敗",
};

/**
 * 「3 分前」「2 時間前」「5 日前」の相対表示。/status の「最終登録」「最終成功」に使う。
 * 未来 (時計のずれ) は「たった今」に丸める。null は空文字。
 */
export function formatRelative(date: Date | string | null, now: Date = new Date()): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  const sec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (sec < 60) return "たった今";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分前`;
  const hour = Math.floor(min / 60);
  if (hour < 48) return `${hour} 時間前`;
  return `${Math.floor(hour / 24)} 日前`;
}

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

/**
 * 実時刻を JST の「YYYY-MM-DD」で返す。
 *
 * `canonicalDate` のような「YYYY-MM-DD の UTC 00:00」格納規約の列は UTC で切るのが正しいが、
 * `SourceRecord.publishedAt` のような実時刻を UTC で切ると JST 0〜9 時のデータが前日に落ちる。
 * `toISOString().slice(0, 10)` も同じ理由で使わない (Vercel は UTC)。
 */
export function toJstDateOnly(d: Date | null | undefined): string | null {
  if (!d) return null;
  // en-CA ロケールは YYYY-MM-DD 形式を返す
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** JST の今日を「YYYY-MM-DD」で返す (記事編集の「今日にする」) */
export function todayJst(): string {
  return toJstDateOnly(new Date())!;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 暦に実在する「YYYY-MM-DD」か。
 *
 * `Date.parse("2026-02-30")` は 3/2 に**正規化して通る**ので、正規表現だけでは
 * 弾けない (画面の `<input type="date">` は防げるが REST は防げない)。往復で確かめる。
 */
export function isValidDateString(date: string): boolean {
  if (!DATE_ONLY_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** 「YYYY-MM-DD」に日数を足す。暦日文字列どうしの演算なので UTC で計算してよい */
export function addDaysToDateString(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 「2026-08-01」→「2026年8月1日」(記事タイトル・画面見出し用) */
export function formatJpDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${y}年${m}月${d}日`;
}
