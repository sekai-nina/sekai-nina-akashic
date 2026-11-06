/** その日のトーク画面の純粋な判定。トークの素材キーは JST の "YYYY-MM-DD"。 */

export type TalkDayScope = "focus" | "all";

export function isTalkDayKey(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

/** 話し手。アセットのタイトルは `大田美月トーク 2026.11.5 7:06` の形。 */
export function talkSpeaker(title: string): string | null {
  return /^(.+?)トーク\s/.exec(title)?.[1] ?? null;
}

/**
 * そのメッセージ全体を指す行か。範囲の抜粋やメモだけの行は全体ではない。
 * 抜粋もメモも無い行は、メッセージごと入れたもの。
 */
export function isWholeMessageItem(body: string, item: { excerpt: string; note: string }): boolean {
  const excerpt = item.excerpt.trim();
  if (excerpt) return excerpt === body.trim();
  return !body.trim() || !item.note.trim();
}

/**
 * もう一度クリップさせないメッセージか。
 * 企画の行は、抜粋が本文全体のもの (クリップから移した行) だけを数える。
 * 抜粋の無い行は素材として企画へ入れただけで、クリップしたことにはならない。
 * 本文の無いメッセージをクリップから移した行もここに入るが、見分ける列が無いので受け入れる。
 */
export function isMessageClipped(body: string, item: { excerpt: string; note: string; inPool: boolean }): boolean {
  if (!item.inPool && !item.excerpt.trim()) return false;
  return isWholeMessageItem(body, item);
}

/** 全日の中で隣り合う日。`older` は一覧で下の行にあたる。 */
export function adjacentTalkDays(days: string[], day: string): { newer: string | null; older: string | null } {
  const sorted = [...new Set(days)].sort();
  return {
    newer: sorted.find((d) => d > day) ?? null,
    older: sorted.filter((d) => d < day).at(-1) ?? null,
  };
}

/** 一覧の順 (新しい日から古い日へ) で次に見る、まだ済でない日。 */
export function nextUnfinishedTalkDay(focusDays: string[], doneDays: Set<string>, day: string): string | null {
  return [...new Set(focusDays)].filter((d) => d < day && !doneDays.has(d)).sort().at(-1) ?? null;
}

/**
 * 言及の文脈。トークはメンバーごとの部屋なので、同じ話し手の前後のメッセージを返す。
 * `ordered` は時刻順。`before` も時刻順で、末尾が言及の直前。
 */
export function talkThread<T extends { assetId: string; speaker: string }>(ordered: T[], assetId: string): { before: T[]; after: T[] } {
  const index = ordered.findIndex((m) => m.assetId === assetId);
  if (index < 0) return { before: [], after: [] };
  const sameSpeaker = (m: T) => m.speaker === ordered[index].speaker;
  return { before: ordered.slice(0, index).filter(sameSpeaker), after: ordered.slice(index + 1).filter(sameSpeaker) };
}
