/**
 * TikTok 監視まわりの純粋な部分 (#179)。**DB を触らないモジュールに置く**
 * (`src/lib/insta/targets.ts` と同じ理由: テストが `@/lib/db` を巻き込むと CI で落ちる)。
 */

/** TikTok のハンドルとして受け付ける形 (英数・`.`・`_`、24 文字まで) */
export const HANDLE_PATTERN = /^[a-z0-9._]{1,24}$/;

/** 動画 ID (URL 末尾の数字) として受け付ける形。snowflake なので 19 桁前後 */
export const VIDEO_ID_PATTERN = /^\d{6,25}$/;

/** 対象ごとの巡回間隔の範囲 (分) */
export const INTERVAL_MIN_MINUTES = 5;
export const INTERVAL_MAX_MINUTES = 10080;
export const DEFAULT_INTERVAL_MINUTES = 30;

/** DL / 登録に失敗した動画を再試行する回数。これを超えたら人が「再試行」を押すまで放置 */
export const MAX_ATTEMPTS = 3;
/** 失敗した動画を次に返すまで空ける時間 (分)。backfill が pending を連続で引くとき、同じ失敗を数分で使い切らないため */
export const RETRY_COOLDOWN_MINUTES = 15;

/** akashic が 1 回の応答で bot に渡す DL 対象の上限 (backfill で一気に 1,000 本返さない) */
export const MAX_PENDING_PER_RESPONSE = 20;
/** 1 回の sightings で受け付ける動画数 */
export const MAX_SIGHTINGS_PER_REQUEST = 500;

/** 画面の「直近の動画」に出す本数 */
export const RECENT_VIDEOS_LIMIT = 50;

/** 文字数の上限 (画面の maxLength / zod / ドメインで共用) */
export const SOURCE_NAME_MAX = 100;
export const CAPTION_FILTER_MAX = 200;
export const NOTE_MAX = 200;
export const ERROR_MAX = 300;
export const CAPTION_MAX = 5000;

/** 入力の形式が不正 (400) */
export class TiktokTargetError extends Error {}
/** 対象・動画・アセットが見つからない (404) */
export class TiktokNotFoundError extends Error {}
/** 台帳と食い違う (409): 別の動画に紐づいたアセット、別のアセットで登録済みの動画 */
export class TiktokConflictError extends Error {}

/**
 * 入力されたハンドルを均す。`@name` や URL を貼られても拾えるようにする。
 */
export function normalizeHandle(raw: string): string {
  let h = raw.trim().toLowerCase();
  h = h.replace(/^https?:\/\/(www\.)?tiktok\.com\//, "");
  h = h.replace(/^@/, "");
  h = h.replace(/[/?#].*$/, "");
  if (!HANDLE_PATTERN.test(h)) {
    throw new TiktokTargetError(`ハンドルの形式が不正です: ${raw}`);
  }
  return h;
}

export function videoUrl(handle: string, videoId: string): string {
  return `https://www.tiktok.com/@${handle}/video/${videoId}`;
}

export function profileUrl(handle: string): string {
  return `https://www.tiktok.com/@${handle}`;
}

/** キャプションの絞り込み (`|` 区切り) を語の配列に。空なら [] = 絞らない */
export function parseCaptionFilter(raw: string): string[] {
  return raw
    .split("|")
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/** 絞り込みに合うか。語が無ければ全部合う。いずれかを含めば合う (大文字小文字は区別しない) */
export function captionMatches(caption: string, filter: string): boolean {
  const words = parseCaptionFilter(filter);
  if (words.length === 0) return true;
  const c = caption.toLowerCase();
  return words.some((w) => c.includes(w.toLowerCase()));
}

/** 出典エンティティの名前。対象に sourceName が無ければハンドルから組む */
export function sourceEntityName(target: { handle: string; sourceName: string }): string {
  return target.sourceName.trim() || `TikTok @${target.handle}`;
}

/**
 * cover 画像として取りに行ってよい URL か。
 * bot (= write 権限の API キー) が送る値をサーバが fetch するので、TikTok の CDN に限る (SSRF 対策)。
 */
export function isAllowedCoverUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return (
    host === "tiktok.com" ||
    host.endsWith(".tiktok.com") ||
    host.endsWith(".tiktokcdn.com") ||
    host.endsWith(".tiktokcdn-us.com") ||
    host.endsWith(".tiktokcdn-eu.com")
  );
}
