import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { CandidateGroupKind } from "@/lib/meetgreet/candidates";
import type { ExclusionKind } from "@/lib/meetgreet/types";
import type { NinaAppearance } from "@/lib/nina";
import {
  TextType,
  type AnnouncementKind,
  type ArticleTemplate,
  type ArticleType,
  type ClearanceLevel,
  type InstaStoryJobStatus,
  type InstaWatchTier,
  type JobRunStatus,
  type LlmProvider,
  type LlmUsageSource,
  type LiveSongRole,
  type MeetGreetEdition,
  type MeetGreetFormat,
  type PlaceKind,
  type ReleaseKind,
  type SongParticipation,
  type StatusLevel,
  type TiktokVideoStatus,
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

/** AssetText の種類 */
export const TEXT_TYPE_LABELS: Record<string, string> = {
  title: "タイトル",
  body: "本文",
  description: "説明",
  message_body: "メッセージ本文",
  ocr: "OCR",
  transcript: "文字起こし",
  note: "メモ",
  extracted: "抽出テキスト",
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

/** タグの区分 (Entity.tagGroup)。null は一般タグで、ENTITY_TYPE_LABELS.tag を使う */
export const TAG_GROUP_LABELS: Record<string, string> = {
  hinakoi: "ひなこい",
  unis_on_air: "ユニエア",
};

/**
 * エンティティを種別ごとに並べるときの区分キー。区分付きタグ (ゲームのカード名) は
 * 一般タグに埋もれさせないよう `tag:<区分>` に分ける。
 */
export function entityGroupKey(e: { type: string; tagGroup?: string | null }): string {
  return e.type === "tag" && e.tagGroup ? `tag:${e.tagGroup}` : e.type;
}

/** entityGroupKey ごとに束ねる。区分付きタグは TAG_GROUP_LABELS の順で末尾に回す (名前順だと一般タグより前に出ることがある) */
export function groupEntitiesByKey<T extends { type: string; tagGroup?: string | null }>(
  entities: T[]
): { key: string; label: string; items: T[] }[] {
  const order = (key: string) =>
    key.startsWith("tag:") ? 1 + Object.keys(TAG_GROUP_LABELS).indexOf(key.slice(4)) : 0;
  const keys = [...new Set(entities.map(entityGroupKey))].sort((a, b) => order(a) - order(b));
  return keys.map((key) => ({
    key,
    label: key.startsWith("tag:")
      ? (TAG_GROUP_LABELS[key.slice(4)] ?? key)
      : (ENTITY_TYPE_LABELS[key] ?? key),
    items: entities.filter((e) => entityGroupKey(e) === key),
  }));
}

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

/** 聖地マップのピン・絞り込み用。種類が未設定の聖地も 1 つの種類として並べる */
export const MAP_PLACE_KIND_LABELS: Record<PlaceKind | "unset", string> = { ...PLACE_KIND_LABELS, unset: "未設定" };

/**
 * 聖地のクリアランス。公開サイトの聖地マップと記事の locations に出るのは internal まで (#283)。
 * 生活圏など、記事には紐づけたいがサイトに出したくない場所は confidential 以上にする
 */
export const PLACE_CLASSIFICATION_LABELS: Record<ClearanceLevel, string> = {
  public: "公開 (サイトに出す)",
  internal: "一般 (サイトに出す)",
  confidential: "限定 (サイトに出さない)",
  restricted: "極秘 (サイトに出さない)",
};

/** TikTok 台帳の動画の状態 (#179) */
export const TIKTOK_VIDEO_STATUS_LABELS: Record<TiktokVideoStatus, string> = {
  skipped_initial: "既知（未取得）",
  pending: "取得待ち",
  registered: "登録済み",
  failed: "失敗",
};

/** ミーグリの形式。「ミーグリ」を後ろに付けて使う (記事・画面では略称のオンミ / リアミを使わない) */
export const MEETGREET_FORMAT_LABELS: Record<MeetGreetFormat, string> = {
  online: "オンライン",
  real: "リアル",
};

/** ミーグリの盤 (オンラインだけ)。公開サイトのカードにもこの表記で出る */
export const MEETGREET_EDITION_LABELS: Record<MeetGreetEdition, string> = {
  regular: "通常盤",
  limited: "初回限定盤",
};

/** ドシエ名など内部向けの略称 (手作業時代の `2026-08-09 通常オンミ` に合わせる) */
export const MEETGREET_FORMAT_SHORT_LABELS: Record<MeetGreetFormat, string> = {
  online: "オンミ",
  real: "リアミ",
};

/** 曲マスタ: 坂井新奈の参加楽曲か (#167) */
export const SONG_PARTICIPATION_LABELS: Record<SongParticipation, string> = {
  unknown: "未確認",
  member: "参加",
  none: "不参加",
};

/** 曲マスタ: 作品の種別 */
export const RELEASE_KIND_LABELS: Record<ReleaseKind, string> = {
  single: "シングル",
  album: "アルバム",
};

/** ライブの公演で曲がどう扱われたか */
export const LIVE_SONG_ROLE_LABELS: Record<LiveSongRole, string> = {
  performed: "披露",
  center: "センター",
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

/** 記事の追記で「足さない」と決めるものの種別 (#134)。除外キーの接頭辞と同じ */
export const EXCLUSION_KIND_LABELS: Record<ExclusionKind | "asset", string> = {
  quote: "引用",
  report: "レポ",
  tiktok: "TikTok",
  talk: "トーク",
  blogImage: "ブログ画像",
  /** 本文の行を伴わない出典 (#267)。キーは `asset:` なので画面の表記には出ない (型の網羅のため置く) */
  source: "出典",
  /**
   * talk / blogImage / source のキーは `asset:` で持つ。source を分けないのは、おでかけで外したトークが
   * 「出典だけ」として戻ってこないようにするため
   */
  asset: "素材",
};

/** 記事テンプレート (#169)。ドシエから記事を組み立てる型 */
export const ARTICLE_TEMPLATE_LABELS: Record<ArticleTemplate, string> = {
  meetgreet: "ミーグリ",
  live: "ライブ",
  outing: "おでかけ",
  quote_blog: "言葉（ブログの名言）",
  quote_situational: "言葉（状況つき）",
  attribute: "スナップ",
};

/** 本人ブログ → 言葉記事の進捗 (`/progress/blog`, #206)。キーは `BlogQuoteStatus` */
export const BLOG_QUOTE_STATUS_LABELS: Record<"todo" | "in_progress" | "done" | "excluded", string> = {
  todo: "未着手",
  in_progress: "作業中",
  done: "記事化済み",
  excluded: "対象外",
};

/** 坂井新奈が出ているか (#261) */
export const NINA_APPEARANCE_LABELS: Record<NinaAppearance, string> = {
  appears: "出ている",
  absent: "出ていない",
  unchecked: "未確認",
};

/** 番組の回の進捗 (`/progress/hinaai` / `madamada` / `hinanari`, #208)。キーは `EpisodeStatus` */
export const SHOW_EPISODE_STATUS_LABELS: Record<"todo" | "partial" | "done" | "excluded", string> = {
  todo: "未着手",
  partial: "途中",
  done: "済",
  excluded: "出演なし",
};

/** お知らせの種類。公開サイトの一覧で見出しの前に出る小さな文字 */
export const ANNOUNCEMENT_KIND_LABELS: Record<AnnouncementKind, string> = {
  feature: "機能",
  article: "記事",
  info: "運営",
};

/** insta-watch の巡回頻度帯。/admin/insta の一覧に出す (フォームは既定の分数込みの文言を別に持つ) */
export const INSTA_WATCH_TIER_LABELS: Record<InstaWatchTier, string> = {
  hot: "高頻度",
  normal: "通常",
  cold: "低頻度",
};

/** story ジョブ (#178) の状態。/admin/insta の一覧に出す */
export const INSTA_STORY_JOB_STATUS_LABELS: Record<InstaStoryJobStatus, string> = {
  pending: "待機",
  dispatched: "送信済み",
  processing: "iPad で処理中",
  completed: "完了",
  failed: "失敗",
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
  groq: "Groq",
};

/**
 * 後払い (月末にカードへ請求) のプロバイダ。前払いのクレジットが無いので、残高の記録・
 * 残り日数の判定をしない (/status に「残高が未登録」と出続けないように)
 */
export const LLM_POSTPAID_PROVIDERS: ReadonlySet<LlmProvider> = new Set<LlmProvider>(["groq"]);

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
  groq: "https://console.groq.com/settings/billing",
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

/** 実時刻を JST の `<input type="datetime-local">` 表記 "YYYY-MM-DDTHH:mm" にする (分まで) */
export function toJstDateTimeLocal(d: Date | null | undefined): string {
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // hour は "24" が出うる (hourCycle の癖) ので 0 に寄せる
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
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

/**
 * 「2025-09-20」〜「2025-11-21」→「2025年9月20日〜11月21日」(ライブの公演期間 #148)。
 * 同じ日なら日付だけ、年をまたぐなら後ろも年から出す。記事の date_display にも使う
 */
export function formatJpDateRange(first: string, last: string): string {
  if (last === first) return formatJpDate(first);
  const [fy] = first.split("-");
  const [ly, lm, ld] = last.split("-");
  const tail = fy === ly ? `${Number(lm)}月${Number(ld)}日` : formatJpDate(last);
  return `${formatJpDate(first)}〜${tail}`;
}

/** 素材のクリップ進捗 (#233)。データソースのキーは coverage と共通。 */
export const MATERIAL_SOURCE_LABELS: Record<string, string> = {
  blog: "ブログ", talk: "トーク", hinaai: "ひなあい・まだまだ", ninarimashou: "ひななり",
  hinachan: "日向坂ちゃんねる", official_ch: "公式チャンネル", magazine: "雑誌",
  instagram: "Instagram", tiktok: "TikTok", radio: "ラジオ", showroom: "SHOWROOM", x_official: "X 公式",
};
export const MATERIAL_PROGRESS_LABELS = {
  title: "素材のクリップ・記事化の進捗", clipProgress: "クリップ進捗", articleProgress: "記事化の進捗",
  markDone: "済にする", done: "クリップ済", unfinished: "未クリップ", finish: "この素材はクリップし切った", undo: "クリップ済を解除",
  exclude: "手動対象を解除",
  description: "本人著・本文で言及ありの素材と、アセット詳細でクリップ済にした素材が分母です。割合とクリップ数は閲覧できる範囲で集計し、移動先の企画も含めます。共有進捗を更新できない場合は、保存時にお知らせします。",
  clips: "クリップ", empty: "素材はありません", manual: "手動対象", noAssets: "アセット未登録",
  saving: "保存中…", failed: "保存に失敗しました", daily: "この日（JST）全体の進捗です", previous: "前へ", next: "次へ",
  authorFilter: "書き手で絞り込む",
} as const;

/** ブログの書き手での絞り込み (/progress/materials/blog) */
export const MATERIAL_AUTHOR_FILTER_LABELS = {
  all: "すべて", self: "本人のブログ", others: "他メンバーのブログ（言及あり）",
} as const;

/** 記事を作る入口の共通文言 (#233 段階2)。 */
export const ARTICLE_WORKFLOW_LABELS = {
  makeArticle: "記事にする", appendArticle: "記事に追記する", openWorkflow: "企画で記事を作る",
  continueArticle: "記事の差分を確認する", backToDossier: "素材の企画へ", fixedTemplate: "素材の種類に合わせたテンプレートです。",
  template: "1. テンプレート", article: "2. 差分を確認して保存", next: "3. 本文を確認して公開へ",
  preparation: "準備状況", prepareHelp: "開催情報・公演・レポ・スケッチの編集は準備画面で行えます。",
  backToPreparation: "準備画面へ", materials: "素材", reports: "採用済みレポ", sketch: "スケッチ",
  ready: "選択済み", unset: "未選択", needsSync: "記事を作った後に素材が変わっています。差分を確認してください。",
  liveAppendHelp: "公演の表は追記時に作り直します。本人の感想・レポ・関連メディアは、まだ無いものだけを足します。",
  chooseArticle: "この企画には複数の記事があります。追記する記事を選んでください。",
  chooseTemplate: "先にテンプレートを選んでください。", chooseTarget: "追記する記事を選ぶと差分を確認できます。",
  unsupportedTemplate: "このテンプレートは記事の組み立てに対応していません。",
  readOnly: "この記事を作成・更新する権限がありません。", viewArticle: "記事を開く", editArticle: "記事を開いて編集",
  selectQuote: "名言集に載せる一節を選ぶ", publish: "公開の確認へ", afterSave: "保存した記事の本文・出典を確認してから公開へ進めます。",
  saved: "記事を保存しました。", draft: "下書き", saveDoesNotPublish: "保存しただけでは公開されません。",
  generationHelp: "記事のプレビュー・保存は、素材の企画から共通の記事画面で行います。",
  unavailableDossier: "素材の企画を閲覧できないため、記事を生成できません。",
  pendingClips: (n: number) => `記事に載っていないクリップ ${n} 件`,
  clipNote: "メモ",
  pendingClipsHelp: "企画に入っているのに、まだ記事に載っていないクリップです。記事に反映すると載り、ここから消えます。載せないものは、反映するときに載せずに保存すると今後足さないものとして消えます。",
  nextPending: "次の反映待ちへ", pendingQueue: (n: number) => `反映待ちの企画 ${n} 本`, noMorePending: "反映待ちの企画はこれで最後です。",
  backToPendingList: "反映待ちの一覧へ",
  aiMerge: "新しいクリップを本文に書き足す",
} as const;

/** 企画一覧 (`/dossiers`) のタブとカード */
export const DOSSIER_LIST_LABELS = {
  draft: "未記事化", pending: "反映待ち", written: "記事化済み", all: "すべて",
  pendingBadge: (n: number) => `未反映 ${n} 件`, addedOn: (date: string) => `${date} 追加`,
  toArticle: "記事に反映する",
} as const;

/** 公開サイトの鮮度管理 (#233 段階3)。 */
export const COVERAGE_LABELS = {
  title: "収集状況", description: "ソースごとに、いつまでの分を取り込んだか（収集済みの日付）を管理します。公開サイトの /status に出ます。",
  progressLink: "人がどこまで見たかは記事化の進捗へ", readOnly: "（閲覧のみ）", list: "収集済みの日付", settings: "ソース管理",
  legend: "日付は JST 基準です。自動のソースは bot が最後に正常に動いた日の前日までで、投稿の無い日も進みます。bot が止まると日付も止まります。",
  until: "まで収集済み", unknown: "未確認", auto: "自動", manual: "手入力", noReport: "報告なし", lastError: "直近はエラー",
  latest: "最新の取り込み", items: "件", edit: "収集済みの日付を編集", lastSet: "更新",
  source: "ソース", method: "方式", private: "非公開", showOnSite: "公開サイトの /status に出す",
  empty: "データソースがまだありません。「ソース管理」タブから追加するか、次のコマンドで初期データを投入してください:",
  date: "収集済みの日付（JST）", dateHelp: "その日までの分を取り込めた日付を入力してください。空にすると未確認に戻ります。公開サイトに出ます。",
  save: "保存", saving: "保存中…", close: "閉じる", failed: "保存に失敗しました。時間をおいて再度お試しください。",
} as const;
