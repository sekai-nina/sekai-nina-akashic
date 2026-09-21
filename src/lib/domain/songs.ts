/**
 * 曲マスタ (#167) のドメイン層。
 *
 * `Song` / `Release` / `ReleaseTrack` は非保護 (公開情報) だが、**披露履歴 (`LiveSong` → `Live`)
 * は保護テーブル**なので、それを含む読みは withClearance で行う (件数も見える範囲だけになる)。
 * 名寄せのキーは `normalizeSongTitle` (src/lib/songs/normalize.ts)。
 */

import { Prisma, type SongParticipation } from "@prisma/client";
import { prisma, prismaInternal, withClearance } from "@/lib/db";
import { MAX_SONG_NOTE, MAX_SONG_TITLE } from "@/lib/live/config";
import { normalizeSongTitle } from "@/lib/songs/normalize";
import { logAudit } from "./audit";
import { WorkflowInputError, type ActingUser } from "./article-workflow";

export type { ActingUser };

/** 入力が不正なことを呼び出し元 (REST の 400) に伝える */
export class SongInputError extends WorkflowInputError {}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export interface ListSongsOptions {
  /** 曲名の部分一致 (名寄せキーで比べるので表記揺れに強い) */
  q?: string;
  participation?: SongParticipation;
  /** true = どの作品にも入っていない曲だけ (ライブ限定アレンジ・誤字の候補) */
  orphan?: boolean;
}

const releaseSelect = {
  id: true,
  title: true,
  kind: true,
  releaseDate: true,
  artist: true,
  sonyCode: true,
} satisfies Prisma.ReleaseSelect;

/**
 * 一覧。初出の作品 (発売日が最も古い収録) と披露回数を付ける。
 * 披露回数は見える Live のぶんだけ (withClearance の中で数える)。
 *
 * 並びは **初出の作品の新しい順 → その作品でのトラック順** (画面は作品ごとに見出しを付ける)。
 * 未収録の曲は末尾に題の順。REST も同じ順
 */
export async function listSongs(user: ActingUser, opts: ListSongsOptions = {}) {
  const q = opts.q?.trim() ? normalizeSongTitle(opts.q) : "";
  const where: Prisma.SongWhereInput = {
    ...(q ? { normalizedTitle: { contains: q } } : {}),
    ...(opts.participation ? { participation: opts.participation } : {}),
    ...(opts.orphan ? { tracks: { none: {} } } : {}),
  };
  const rows = await withClearance(user.clearance, (tx) =>
    tx.song.findMany({
      where,
      orderBy: { normalizedTitle: "asc" },
      select: {
        id: true,
        title: true,
        artist: true,
        participation: true,
        note: true,
        tracks: {
          select: { discNo: true, trackNo: true, release: { select: releaseSelect } },
          // 同じ日に 2 作品 (シングルとアルバム) に入ることがあっても初出が揺れないように品番でも並べる
          orderBy: [{ release: { releaseDate: "asc" } }, { release: { sonyCode: "asc" } }],
        },
        _count: { select: { liveSongs: true } },
      },
    })
  );
  const shaped = rows.map((s) => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    participation: s.participation,
    note: s.note,
    /** 初出の作品 (無ければ null = 未収録) */
    firstRelease: s.tracks[0]?.release ?? null,
    /** 初出の作品でのトラック番号 (画面の並び用) */
    firstTrack: s.tracks[0] ? { discNo: s.tracks[0].discNo, trackNo: s.tracks[0].trackNo } : null,
    releaseCount: s.tracks.length,
    performanceCount: s._count.liveSongs,
  }));
  shaped.sort((a, b) => {
    if (!a.firstRelease || !b.firstRelease) {
      if (a.firstRelease) return -1;
      if (b.firstRelease) return 1;
      return a.title.localeCompare(b.title, "ja");
    }
    return (
      b.firstRelease.releaseDate.localeCompare(a.firstRelease.releaseDate) ||
      a.firstRelease.sonyCode.localeCompare(b.firstRelease.sonyCode) ||
      a.firstTrack!.discNo - b.firstTrack!.discNo ||
      a.firstTrack!.trackNo - b.firstTrack!.trackNo
    );
  });
  return shaped;
}

export type SongSummary = Awaited<ReturnType<typeof listSongs>>[number];

/** 詳細。収録作品と、披露した公演 (見える Live だけ) */
export async function getSong(user: ActingUser, id: string) {
  const row = await withClearance(user.clearance, (tx) =>
    tx.song.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        normalizedTitle: true,
        artist: true,
        participation: true,
        note: true,
        createdAt: true,
        updatedAt: true,
        tracks: {
          select: {
            discNo: true,
            trackNo: true,
            editions: true,
            release: { select: { ...releaseSelect, editions: true } },
          },
          orderBy: [{ release: { releaseDate: "asc" } }, { release: { sonyCode: "asc" } }],
        },
        liveSongs: {
          select: {
            role: true,
            live: { select: { id: true, name: true } },
            performance: { select: { id: true, date: true, venue: true, label: true } },
          },
          orderBy: [{ live: { createdAt: "desc" } }, { sortOrder: "asc" }],
        },
      },
    })
  );
  if (!row) return null;

  // 披露履歴はライブごとにまとめる (共通披露曲は performance が null)
  const byLive = new Map<
    string,
    { id: string; name: string; common: boolean; performances: { id: string; date: string; venue: string; label: string; role: string }[] }
  >();
  for (const ls of row.liveSongs) {
    const g = byLive.get(ls.live.id) ?? { id: ls.live.id, name: ls.live.name, common: false, performances: [] };
    if (!ls.performance) g.common = true;
    else g.performances.push({ ...ls.performance, role: ls.role });
    byLive.set(ls.live.id, g);
  }
  for (const g of byLive.values()) g.performances.sort((a, b) => a.date.localeCompare(b.date));
  // ライブは公演日の新しい順 (作成順だと過去のライブを後から入れたときに崩れる。listLives と同じ)。
  // 公演に紐づかない (共通披露曲だけ) ものは末尾
  const lives = [...byLive.values()].sort((a, b) =>
    (b.performances[0]?.date ?? "").localeCompare(a.performances[0]?.date ?? "")
  );

  return {
    id: row.id,
    title: row.title,
    normalizedTitle: row.normalizedTitle,
    artist: row.artist,
    participation: row.participation,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tracks: row.tracks.map((t) => ({
      discNo: t.discNo,
      trackNo: t.trackNo,
      editions: Array.isArray(t.editions) ? t.editions.filter((e): e is string => typeof e === "string") : [],
      release: t.release,
    })),
    lives,
  };
}

export type SongDetail = NonNullable<Awaited<ReturnType<typeof getSong>>>;

export interface UpdateSongInput {
  title?: string;
  participation?: SongParticipation;
  note?: string;
}

/**
 * 曲名・参加・メモの更新。曲名を変えると名寄せキーも計算し直す。
 *
 * - 別の曲と同じキーになるなら更新せず、統合を案内する (unique 違反を生で出さない)
 * - **収録のある曲 (取り込みが作った公式表記) はキーが変わる改名を受けない。** 取り込みは
 *   キーで曲を探すので、変えると次回に公式表記の曲が別に作られ、こちらは未収録の孤児になる。
 *   キーが同じ改名 (「HEY!OHISAMA!」→「HEY！OHISAMA！」) は受ける (次回の取り込みで公式に戻るだけ)
 *
 * `Song` は非保護なので素の prisma でよい。
 */
export async function updateSong(user: ActingUser, id: string, input: UpdateSongInput) {
  const current = await prisma.song.findUnique({
    where: { id },
    select: { title: true, normalizedTitle: true, participation: true, note: true, _count: { select: { tracks: true } } },
  });
  if (!current) throw new SongInputError("曲が見つかりません");

  const data: Prisma.SongUpdateInput = {};
  if (input.title !== undefined) {
    const title = input.title.replace(/\s+/g, " ").trim();
    if (!title) throw new SongInputError("曲名を入れてください");
    if ([...title].length > MAX_SONG_TITLE) throw new SongInputError(`曲名が長すぎます (${MAX_SONG_TITLE} 文字まで)`);
    if (title !== current.title) {
      const normalizedTitle = normalizeSongTitle(title);
      if (normalizedTitle !== current.normalizedTitle && current._count.tracks > 0) {
        throw new SongInputError(
          "収録のある曲は別の曲名に変えられません (取り込みが公式表記で作り直してしまうため)。誤字の曲を正しい曲に統合してください"
        );
      }
      const other = await prisma.song.findFirst({
        where: { id: { not: id }, OR: [{ title }, { normalizedTitle }] },
        select: { id: true, title: true },
      });
      if (other) throw new SongInputError(`「${other.title}」と同じ曲になります。統合してください`);
      data.title = title;
      data.normalizedTitle = normalizedTitle;
    }
  }
  if (input.participation !== undefined && input.participation !== current.participation) {
    data.participation = input.participation;
  }
  if (input.note !== undefined) {
    if ([...input.note].length > MAX_SONG_NOTE) throw new SongInputError(`メモが長すぎます (${MAX_SONG_NOTE} 文字まで)`);
    if (input.note.trim() !== current.note) data.note = input.note.trim();
  }
  const fields = Object.keys(data);
  if (fields.length === 0) return { id, title: current.title, changed: false as const };

  let row: { id: string; title: string };
  try {
    row = await prisma.song.update({ where: { id }, data, select: { id: true, title: true } });
  } catch (e) {
    // 同じ曲名を同時に作られたとき (上の findFirst との隙間)
    if (isUniqueViolation(e)) throw new SongInputError("同じ曲名の曲が先にできました。統合してください");
    throw e;
  }
  await logAudit({ actorId: user.id, action: "song.update", targetType: "Song", targetId: id, metadata: { fields } });
  return { ...row, changed: true as const };
}

/**
 * 統合: `sourceId` の曲 (誤字など) を `targetId` の曲に寄せて、source を消す。
 *
 * - **統合元にできるのは未収録の曲だけ。** 取り込みは名寄せキーで曲を探すので、収録のある
 *   (= 公式表記の) 曲を消すと次回に作り直され、寄せた披露履歴が公式の曲から離れる。
 *   逆向き (公式の曲を統合先に) で行う
 * - 披露履歴 (LiveSong) は **見えないライブのぶんも含めて**付け替える。統合はマスタの整理で、
 *   見える範囲だけ付け替えると残りが RESTRICT で消せず中途半端になる。そのため prismaInternal
 *   で行い、admin に限る。返すのは件数だけ (中身は返さない)
 * - 同じ公演に両方の表記が入っていた場合は付け替えで同じ行が 2 つになるので、1 つにする
 * - 参加フラグとメモは target に無いときだけ source のものを引き継ぐ
 */
export async function mergeSongs(user: ActingUser, sourceId: string, targetId: string) {
  if (user.role !== "admin") throw new SongInputError("統合は管理者だけができます");
  if (sourceId === targetId) throw new SongInputError("同じ曲です");

  const result = await prismaInternal.$transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.song.findUnique({
        where: { id: sourceId },
        select: { id: true, title: true, participation: true, note: true, _count: { select: { tracks: true } } },
      }),
      tx.song.findUnique({ where: { id: targetId }, select: { id: true, title: true, participation: true, note: true } }),
    ]);
    if (!source || !target) throw new SongInputError("曲が見つかりません");
    if (source._count.tracks > 0) {
      throw new SongInputError("収録のある曲は統合元にできません。逆向き (この曲を統合先に) で統合してください");
    }

    const moved = await tx.liveSong.updateMany({ where: { songId: source.id }, data: { songId: target.id } });
    // 付け替えで同じ (ライブ, 公演, 曲, 役割) の行が 2 つになったら古いほうを消す
    const deduped = await tx.$executeRaw`
      DELETE FROM "LiveSong" a USING "LiveSong" b
      WHERE a."songId" = ${target.id} AND b."songId" = ${target.id}
        AND a."liveId" = b."liveId" AND a."role" = b."role"
        AND a."performanceId" IS NOT DISTINCT FROM b."performanceId"
        AND a.id > b.id`;

    const inherit: Prisma.SongUpdateInput = {};
    if (target.participation === "unknown" && source.participation !== "unknown") inherit.participation = source.participation;
    if (!target.note && source.note) inherit.note = source.note;
    if (Object.keys(inherit).length > 0) await tx.song.update({ where: { id: target.id }, data: inherit });

    await tx.song.delete({ where: { id: source.id } });
    return { sourceTitle: source.title, targetTitle: target.title, performances: moved.count - deduped };
  });

  await logAudit({
    actorId: user.id,
    action: "song.merge",
    targetType: "Song",
    targetId: targetId,
    metadata: { sourceId, ...result },
  });
  return { sourceTitle: result.sourceTitle, targetTitle: result.targetTitle };
}

/** 公演フォームの警告用: マスタにある曲の名寄せキー (非保護なので素の prisma) */
export async function listSongKeys(): Promise<string[]> {
  const rows = await prisma.song.findMany({ select: { normalizedTitle: true } });
  return rows.map((r) => r.normalizedTitle);
}

/** 統合先の候補 (id と題だけ。非保護なので素の prisma) */
export async function listMergeTargets(excludeId: string): Promise<{ id: string; title: string }[]> {
  return prisma.song.findMany({
    where: { id: { not: excludeId } },
    select: { id: true, title: true },
    orderBy: { normalizedTitle: "asc" },
  });
}
