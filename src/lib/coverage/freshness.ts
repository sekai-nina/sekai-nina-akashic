import { jstDayString } from "@/lib/utils";

export class CoverageInputError extends Error {}
export class CoveragePermissionError extends Error {}

/** JST の暦日。日付の繰り上がりや未来の日付を許可しない。保存は UTC 00:00 の DATE。 */
export function parseConfirmedUntil(value: string | null, now = new Date()): Date | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CoverageInputError("日付は YYYY-MM-DD で入力してください");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < "1900-01-01") {
    throw new CoverageInputError("有効な日付を入力してください");
  }
  if (value > jstDayString(now)) throw new CoverageInputError("確認済み日付は今日（JST）以前にしてください");
  return date;
}

/** 旧チェックからの読み取り互換。日付なしは除外し、同じ日の全件が済んだ日まで返す。 */
export function legacyConfirmedUntil(
  items: { itemKey: string; itemDate: Date | null }[],
  checked?: Set<string>,
): string | null {
  if (!checked?.size) return null;
  const days = new Map<string, boolean>();
  for (const item of items) {
    if (!item.itemDate) continue;
    const day = item.itemDate.toISOString().slice(0, 10);
    days.set(day, (days.get(day) ?? true) && checked.has(item.itemKey));
  }
  let until: string | null = null;
  for (const [day, complete] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!complete) break;
    until = day;
  }
  return until;
}
