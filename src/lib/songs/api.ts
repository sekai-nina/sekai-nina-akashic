/**
 * 曲マスタ (#167) の入力スキーマと REST (/api/v1/songs) の射影。
 * 画面 (Server Actions) と REST で同じスキーマを通す。クライアント部品からは読まない (zod)。
 */

import { z } from "zod";
import type { SongSummary } from "@/lib/domain/songs";
import { MAX_SONG_NOTE, MAX_SONG_TITLE } from "@/lib/live/config";

export const UpdateSongSchema = z
  .object({
    title: z.string().max(MAX_SONG_TITLE).optional(),
    participation: z.enum(["unknown", "member", "none"]).optional(),
    note: z.string().max(MAX_SONG_NOTE).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "更新項目がありません" });

/**
 * GET のクエリ。他の GET と同じく**未知のパラメータは無視する** (strict にしない)。
 * 空の値 (`?participation=`) も「指定なし」として扱う
 */
export const ListSongsQuerySchema = z.object({
  q: z.string().max(100).optional(),
  participation: z.enum(["unknown", "member", "none"]).optional(),
  /** "1" でどの作品にも入っていない曲だけ */
  orphan: z.enum(["1", "0"]).optional(),
});

/** URLSearchParams → スキーマの入力 (空文字は落とす) */
export function listSongsQueryInput(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["q", "participation", "orphan"]) {
    const v = params.get(key);
    if (v) out[key] = v;
  }
  return out;
}

export function projectSong(s: SongSummary) {
  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    participation: s.participation,
    note: s.note,
    firstRelease: s.firstRelease
      ? {
          id: s.firstRelease.id,
          title: s.firstRelease.title,
          kind: s.firstRelease.kind,
          releaseDate: s.firstRelease.releaseDate,
          artist: s.firstRelease.artist,
          trackNo: s.firstTrack?.trackNo ?? null,
        }
      : null,
    releaseCount: s.releaseCount,
    /** キーの持ち主に見えるライブでの披露回数 */
    performanceCount: s.performanceCount,
  };
}
