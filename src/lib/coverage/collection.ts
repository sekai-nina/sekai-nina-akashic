import { jstDayString } from "@/lib/utils";

/**
 * ソースごとの「いつまでの分を取り込んだか（収集済みの日付）」(#253)。
 *
 * bot のハートビートで出せるソースは、その bot が最後に正常に動いた日（JST）の前日を収集済みの日付とする。
 * 0:05 に動いた回はその日の後半をまだ見ていないので、日付が丸ごと取れたと言えるのは前日まで。
 * 投稿の無い日も「確認して何も無かった」として進み、bot が止まれば日付も止まる。
 * それ以外のソースは DataSource.collectedUntil に手で入れる。
 */

export class CoverageInputError extends Error {}
export class CoveragePermissionError extends Error {}
export class CoverageNotFoundError extends Error {}

export const AUTO_SOURCE_MESSAGE = "このソースは bot の稼働記録から自動で出すため、手では入力できません";

/**
 * DataSource.key → そのソースを見ている bot のハートビート key (`Job.key`)。
 * ここにあるソースは自動で、手入力できない。Lemino / Instagram の収集にハートビートを足したら 1 行加える。
 */
export const SOURCE_HEARTBEAT_JOBS: Record<string, string> = {
  blog: "bot.blog_watch",
  talk: "bot.talk_monitor",
  hinachan: "bot.youtube_watch",
  official_ch: "bot.youtube_watch",
  tiktok: "bot.tiktok_watch",
};

export function heartbeatJobKey(sourceKey: string): string | null {
  return SOURCE_HEARTBEAT_JOBS[sourceKey] ?? null;
}

/** ハートビートの最終成功時刻 → 収集済みの日付（その JST 暦日の前日）。報告が無ければ null。 */
export function autoCollectedUntil(lastOkAt: Date | null | undefined): string | null {
  if (!lastOkAt) return null;
  const day = new Date(`${jstDayString(lastOkAt)}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** JST の暦日。日付の繰り上がりや未来の日付を許可しない。保存は UTC 00:00 の DATE。 */
export function parseCollectedUntil(value: string | null, now = new Date()): Date | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CoverageInputError("日付は YYYY-MM-DD で入力してください");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < "1900-01-01") {
    throw new CoverageInputError("有効な日付を入力してください");
  }
  if (value > jstDayString(now)) throw new CoverageInputError("収集済みの日付は今日（JST）以前にしてください");
  return date;
}
