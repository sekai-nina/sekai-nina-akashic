/**
 * 公演のセトリを Sakamichi Universe から組む (保存はしない。保存は replacePerformanceSetlist)。
 *
 * セトリの画面の「Sakamichi Universe から読み込む」と、過去の公演をまとめて入れる
 * `pnpm cli:import-setlists-su` が使う。参加は備考 → 全員で披露するライブか → 坂井新奈の参加楽曲の順に決める
 * (sakamichi-universe.ts の analyzeRemark)。
 */

import type { SongParticipation } from "@prisma/client";
import {
  fetchSuLives,
  fetchSuParticipationTitles,
  fetchSuSetlist,
  isWholeLineupLive,
  matchSuLive,
  SU_SOURCE_LABEL,
  toSetlistRows,
  type FallbackReading,
  type SuLive,
  type SuSetlistRow,
} from "@/lib/live/sakamichi-universe";
import { normalizeSongTitle } from "@/lib/songs/normalize";
import type { SetlistSource } from "./lives";

export type SuPreview =
  | { ok: true; live: SuLive; rows: SuSetlistRow[]; source: SetlistSource }
  /** 同じ日に複数あって選べない。starttime を付けて呼び直す */
  | { ok: false; reason: "ambiguous"; candidates: SuLive[] }
  | { ok: false; reason: "not_found" | "empty"; candidates: SuLive[] };

/** 公演に今入っている披露曲 (手入力 / これまでの組み直し) */
export interface CurrentSongs {
  /** 共通披露曲 + この公演の追加曲 */
  songs: string[];
  centerSongs: string[];
}

/**
 * 備考で読めない曲 (= いつもの編成。「C松尾」「［卒業セレモニー］」だけ等) の参加とセンター:
 *
 * 1. 公演に披露曲が入っていれば、それに従う (人が確かめて入れたもの。全員曲の JOYFUL LOVE など、
 *    備考が空でも坂井新奈が出ている曲がある)
 * 2. 5 期生のライブ・ひなた坂46 LIVE なら参加 (全員で全曲)
 * 3. 坂井新奈の参加楽曲 (Sakamichi Universe)、または曲マスタで「参加楽曲」と明示した曲なら参加
 */
export function participationFallback(
  liveTitle: string,
  ninaSongs: Iterable<string>,
  participation: Record<string, SongParticipation>,
  current?: CurrentSongs
) {
  const whole = isWholeLineupLive(liveTitle);
  const mine = new Set([...ninaSongs].map(normalizeSongTitle));
  const recorded = new Set((current?.songs ?? []).map(normalizeSongTitle));
  const recordedCenter = new Set((current?.centerSongs ?? []).map(normalizeSongTitle));
  return (title: string): FallbackReading => {
    const key = normalizeSongTitle(title);
    const center = recordedCenter.has(key);
    if (recorded.size > 0) {
      return recorded.has(key) || center
        ? { participated: true, center, reason: center ? "今の記録: センター" : "今の記録: 披露曲" }
        : { participated: false, reason: "今の記録に無い" };
    }
    if (whole) return { participated: true, center, reason: "全員で披露するライブ" };
    if (mine.has(key)) return { participated: true, reason: "参加楽曲 (SU)" };
    if (participation[key] === "member") return { participated: true, reason: "曲マスタ: 参加楽曲" };
    return { participated: false, reason: "参加楽曲でない" };
  };
}

/**
 * 1 公演ぶんを組む。lives を渡せば一覧の取得を省ける (CLI はまとめて 1 回読む)
 */
export async function previewSuSetlist(
  perf: { date: string; label: string; current?: CurrentSongs },
  participation: Record<string, SongParticipation>,
  opts: { lives?: SuLive[]; ninaSongs?: string[]; starttime?: string } = {}
): Promise<SuPreview> {
  const [lives, ninaSongs] = await Promise.all([
    opts.lives ?? fetchSuLives(perf.date),
    opts.ninaSongs ?? fetchSuParticipationTitles(),
  ]);
  const matched = matchSuLive(perf, lives);
  const live = opts.starttime
    ? matched.candidates.find((c) => c.starttime === opts.starttime) ?? null
    : matched.live;
  if (!live) {
    return matched.candidates.length > 1
      ? { ok: false, reason: "ambiguous", candidates: matched.candidates }
      : { ok: false, reason: "not_found", candidates: matched.candidates };
  }
  const items = await fetchSuSetlist(live);
  if (items.length === 0) return { ok: false, reason: "empty", candidates: [live] };
  return {
    ok: true,
    live,
    rows: toSetlistRows(items, participationFallback(live.title, ninaSongs, participation, perf.current)),
    source: { label: SU_SOURCE_LABEL, url: live.html_url },
  };
}
