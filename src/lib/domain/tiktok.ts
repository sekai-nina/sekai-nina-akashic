import type { Prisma, TiktokVideoStatus } from "@prisma/client";
import { prisma, withClearance } from "@/lib/db";
import { invalidateAssetList } from "@/lib/cache";
import { updateAsset } from "@/lib/domain/assets";
import { findOrCreateEntity } from "@/lib/domain/entities";
import { deriveTitle, extractMemberNames, HIGHLIGHT_MEMBER } from "@/lib/tiktok/caption";
import {
  CAPTION_FILTER_MAX,
  captionMatches,
  ERROR_MAX,
  INTERVAL_MAX_MINUTES,
  INTERVAL_MIN_MINUTES,
  isAllowedCoverUrl,
  MAX_ATTEMPTS,
  MAX_PENDING_PER_RESPONSE,
  normalizeHandle,
  NOTE_MAX,
  RECENT_VIDEOS_LIMIT,
  RETRY_COOLDOWN_MINUTES,
  SOURCE_NAME_MAX,
  sourceEntityName,
  TiktokConflictError,
  TiktokNotFoundError,
  TiktokTargetError,
  videoUrl,
} from "@/lib/tiktok/targets";
import { generateAndUploadThumbnails } from "@/lib/thumbnails";

/**
 * TikTok の監視 (#179)。
 *
 * 台帳は akashic が持ち、bot (tiktok-watch) は手足に徹する:
 *   1. bot が profile を開いて見えた動画を `recordTiktokSightings` で報告
 *   2. akashic が「DL すべき動画」を返す (初回接触は全件 skipped_initial にして 0 件)
 *   3. bot が DL → `POST /upload` → `registerTiktokVideo` で akashic がアセットを整える
 *   4. bot が Discord に流して `markTiktokVideoNotified`
 *
 * 画面 (`/admin/tiktok`) は `withClearance` で読み書き、bot も API キーのクリアランスで
 * `withClearance`。cron のように `prismaInternal` で回す経路は無い。
 * **bot の API キーはクリアランス internal 以上が要る** (両テーブルの既定が internal。低いと
 * 対象一覧が無言で空になる)。
 */

export {
  TiktokConflictError,
  TiktokNotFoundError,
  TiktokTargetError,
  normalizeHandle,
} from "@/lib/tiktok/targets";

// ---------------------------------------------------------------- 対象 (画面用)

export interface TiktokTargetView {
  id: string;
  handle: string;
  sourceName: string;
  official: boolean;
  captionFilter: string;
  intervalMinutes: number;
  enabled: boolean;
  note: string;
  secUid: string | null;
  videoCount: number | null;
  lastCheckedAt: Date | null;
  lastError: string;
  lastErrorAt: Date | null;
  updatedAt: Date;
  updatedByName: string | null;
  /** status ごとの件数 */
  counts: Record<TiktokVideoStatus, number>;
}

const TARGET_SELECT = {
  id: true,
  handle: true,
  sourceName: true,
  official: true,
  captionFilter: true,
  intervalMinutes: true,
  enabled: true,
  note: true,
  secUid: true,
  videoCount: true,
  lastCheckedAt: true,
  lastError: true,
  lastErrorAt: true,
  updatedAt: true,
  updatedBy: { select: { name: true } },
} satisfies Prisma.TiktokWatchTargetSelect;

type TargetRow = Prisma.TiktokWatchTargetGetPayload<{ select: typeof TARGET_SELECT }>;

function emptyCounts(): Record<TiktokVideoStatus, number> {
  return { skipped_initial: 0, pending: 0, registered: 0, failed: 0 };
}

function toTargetView(row: TargetRow, counts: Record<TiktokVideoStatus, number>): TiktokTargetView {
  return {
    id: row.id,
    handle: row.handle,
    sourceName: row.sourceName,
    official: row.official,
    captionFilter: row.captionFilter,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    note: row.note,
    secUid: row.secUid,
    videoCount: row.videoCount,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    updatedAt: row.updatedAt,
    updatedByName: row.updatedBy?.name ?? null,
    counts,
  };
}

export async function listTiktokTargets(clearance: string): Promise<TiktokTargetView[]> {
  return withClearance(clearance, async (tx) => {
    const rows = await tx.tiktokWatchTarget.findMany({
      orderBy: [{ enabled: "desc" }, { handle: "asc" }],
      select: TARGET_SELECT,
    });
    const grouped = await tx.tiktokVideo.groupBy({
      by: ["targetId", "status"],
      _count: { _all: true },
    });
    const counts = new Map<string, Record<TiktokVideoStatus, number>>();
    for (const g of grouped) {
      const c = counts.get(g.targetId) ?? emptyCounts();
      c[g.status] = g._count._all;
      counts.set(g.targetId, c);
    }
    return rows.map((r) => toTargetView(r, counts.get(r.id) ?? emptyCounts()));
  });
}

export interface TiktokTargetInput {
  handle: string;
  sourceName: string;
  official: boolean;
  captionFilter: string;
  intervalMinutes: number;
  note: string;
}

function validateInterval(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < INTERVAL_MIN_MINUTES || minutes > INTERVAL_MAX_MINUTES) {
    throw new TiktokTargetError(
      `間隔は ${INTERVAL_MIN_MINUTES} 分〜${INTERVAL_MAX_MINUTES / 1440} 日で指定してください`,
    );
  }
}

/**
 * 一度外したハンドルを入れ直すことがあるので upsert。enabled に戻す。
 * 入れ直しのとき、空で送られた sourceName / note は既存を残す (フォームの空欄で消さない)。
 */
export async function addTiktokTarget(
  input: TiktokTargetInput,
  clearance: string,
  userId: string,
): Promise<TiktokTargetView> {
  const handle = normalizeHandle(input.handle);
  validateInterval(input.intervalMinutes);
  const sourceName = input.sourceName.trim().slice(0, SOURCE_NAME_MAX);
  const note = input.note.trim().slice(0, NOTE_MAX);
  const captionFilter = input.captionFilter.trim().slice(0, CAPTION_FILTER_MAX);
  const row = await withClearance(clearance, (tx) =>
    tx.tiktokWatchTarget.upsert({
      where: { handle },
      create: {
        handle,
        sourceName,
        official: input.official,
        captionFilter,
        intervalMinutes: input.intervalMinutes,
        note,
        updatedById: userId,
      },
      update: {
        ...(sourceName ? { sourceName } : {}),
        official: input.official,
        captionFilter,
        intervalMinutes: input.intervalMinutes,
        ...(note ? { note } : {}),
        enabled: true,
        updatedById: userId,
      },
      select: TARGET_SELECT,
    }),
  );
  return toTargetView(row, emptyCounts());
}

export async function setTiktokTargetEnabled(
  id: string,
  enabled: boolean,
  clearance: string,
  userId: string,
): Promise<void> {
  await withClearance(clearance, (tx) =>
    tx.tiktokWatchTarget.update({ where: { id }, data: { enabled, updatedById: userId } }),
  );
}

/** 動画の台帳ごと消える (Cascade)。登録済みアセットは残る (assetId は台帳側の参照なので) */
export async function deleteTiktokTarget(id: string, clearance: string): Promise<void> {
  await withClearance(clearance, (tx) => tx.tiktokWatchTarget.delete({ where: { id } }));
}

// ---------------------------------------------------------------- 動画 (画面用)

export interface TiktokVideoView {
  id: string;
  videoId: string;
  handle: string;
  url: string;
  createTime: Date;
  caption: string;
  durationSec: number | null;
  status: TiktokVideoStatus;
  notify: boolean;
  attempts: number;
  lastError: string;
  assetId: string | null;
  /** 紐づくアセット。assetId があるのに null なら閲覧者のクリアランスで見えない */
  asset: { title: string; thumbnailUrl: string | null } | null;
  registeredAt: Date | null;
  notifiedAt: Date | null;
  firstSeenAt: Date;
}

export async function listRecentTiktokVideos(
  clearance: string,
  limit = RECENT_VIDEOS_LIMIT,
): Promise<TiktokVideoView[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.tiktokVideo.findMany({
      orderBy: [{ createTime: "desc" }],
      take: limit,
      select: {
        id: true,
        videoId: true,
        createTime: true,
        caption: true,
        durationSec: true,
        status: true,
        notify: true,
        attempts: true,
        lastError: true,
        assetId: true,
        registeredAt: true,
        notifiedAt: true,
        firstSeenAt: true,
        target: { select: { handle: true } },
        asset: { select: { title: true, thumbnailUrl: true } },
      },
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    videoId: r.videoId,
    handle: r.target.handle,
    url: videoUrl(r.target.handle, r.videoId),
    createTime: r.createTime,
    caption: r.caption,
    durationSec: r.durationSec,
    status: r.status,
    notify: r.notify,
    attempts: r.attempts,
    lastError: r.lastError,
    assetId: r.assetId,
    asset: r.asset,
    registeredAt: r.registeredAt,
    notifiedAt: r.notifiedAt,
    firstSeenAt: r.firstSeenAt,
  }));
}

/**
 * 動画を次の周で DL する対象に戻す。失敗が上限に達したものの再試行と、
 * 初回接触で飛ばした過去動画を 1 本だけ取り込みたいときの両方に使う。
 * `notify` は触らない (過去動画は false のまま = 取り込んでも Discord に流さない)。
 * registered / pending の行には効かない (二重登録の入口にしない)。
 */
export async function requeueTiktokVideo(id: string, clearance: string): Promise<boolean> {
  const r = await withClearance(clearance, (tx) =>
    tx.tiktokVideo.updateMany({
      where: { id, status: { in: ["failed", "skipped_initial"] } },
      data: { status: "pending", attempts: 0, lastError: "" },
    }),
  );
  return r.count > 0;
}

/** 対象の失敗 (上限到達も含む) をまとめて戻す。画面に出ない古い失敗の救済用 */
export async function requeueFailedTiktokVideos(targetId: string, clearance: string): Promise<number> {
  const r = await withClearance(clearance, (tx) =>
    tx.tiktokVideo.updateMany({
      where: { targetId, status: "failed" },
      data: { status: "pending", attempts: 0, lastError: "" },
    }),
  );
  return r.count;
}

// ---------------------------------------------------------------- bot 向け

export interface EnabledTiktokTarget {
  handle: string;
  intervalMinutes: number;
  secUid: string | null;
}

export async function getEnabledTiktokTargets(clearance: string): Promise<EnabledTiktokTarget[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.tiktokWatchTarget.findMany({
      where: { enabled: true },
      orderBy: { handle: "asc" },
      select: { handle: true, intervalMinutes: true, secUid: true },
    }),
  );
  return rows;
}

export interface SightedVideo {
  videoId: string;
  createTime: Date;
  caption: string;
  durationSec?: number | null;
  coverUrl?: string | null;
}

export interface SightingsInput {
  videos: SightedVideo[];
  secUid?: string | null;
  videoCount?: number | null;
  /** 過去分を取りに来ている (初回接触扱いにしない。skipped_initial も pending に戻す) */
  backfill?: boolean;
  /**
   * 見えた動画を既知として載せるだけ (DL しない)。新しい行は skipped_initial、既に pending の行も
   * skipped_initial に戻す。backfill の「この日より前は要らない」に使う
   */
  skip?: boolean;
}

export interface PendingVideo {
  videoId: string;
  url: string;
  createTime: Date;
  caption: string;
  /** 登録できたら Discord に流すか (新着だけ true。backfill / 取り込むで戻した過去動画は false) */
  notify: boolean;
}

export interface SightingsResult {
  /** この報告が初回接触だった (見えた動画は全件 skipped_initial にした) */
  initial: boolean;
  /** 新しく台帳に載った本数 */
  added: number;
  /** bot が DL すべき動画 (新しい順、最大 MAX_PENDING_PER_RESPONSE) */
  pending: PendingVideo[];
  /** 対象全体の status ごとの件数 */
  counts: Record<TiktokVideoStatus, number>;
}

/**
 * bot が見た動画一覧を台帳に写し、DL すべきものを返す。
 *
 * - 初回接触 (台帳が空で backfill でない) は見えた動画を全件 `skipped_initial` にする。
 *   対象を足した瞬間に過去 1,000 本を落とし始めないため。`notify` も false にする
 * - 既に載っている動画は、変わったメタデータだけ更新する (status・createTime は触らない。
 *   bot の DOM 保険経路は caption が空で createTime も近似なので、空で上書きしない)。
 *   registered は更新しない (アセットにはもう反映されない)
 * - backfill のときだけ `skipped_initial` を `pending` に戻す (`notify` は false のまま)
 * - 返す pending には**前回の周で取り残した分も含む** (bot が途中で落ちても次の周で拾う)。
 *   失敗は attempts が上限未満で、前回の失敗から RETRY_COOLDOWN_MINUTES 経っていれば含める
 *   (backfill が pending を連続で引くとき、同じ失敗を数分で使い切らないため)
 */
export async function recordTiktokSightings(
  handle: string,
  input: SightingsInput,
  clearance: string,
): Promise<SightingsResult> {
  const h = normalizeHandle(handle);
  const backfill = input.backfill === true && input.skip !== true;
  const skip = input.skip === true;
  return withClearance(clearance, async (tx) => {
    const target = await tx.tiktokWatchTarget.findUnique({
      where: { handle: h },
      select: { id: true, captionFilter: true },
    });
    if (!target) throw new TiktokNotFoundError(`監視対象にありません: ${h}`);

    const existingCount = await tx.tiktokVideo.count({ where: { targetId: target.id } });
    const initial = existingCount === 0 && !backfill && !skip;
    // 取り込む (pending) か既知で載せるだけ (skipped_initial) か。
    // 初回接触・skip・キャプションの絞り込みに合わないものは既知
    const wanted = (caption: string) =>
      !initial && !skip && captionMatches(caption, target.captionFilter);

    const ids = input.videos.map((v) => v.videoId);
    const existing = ids.length
      ? await tx.tiktokVideo.findMany({
          where: { videoId: { in: ids } },
          select: {
            videoId: true,
            targetId: true,
            status: true,
            caption: true,
            durationSec: true,
            coverUrl: true,
          },
        })
      : [];
    const existingById = new Map(existing.map((e) => [e.videoId, e]));

    const toCreate = input.videos.filter((v) => !existingById.has(v.videoId));
    if (toCreate.length > 0) {
      await tx.tiktokVideo.createMany({
        data: toCreate.map((v) => ({
          targetId: target.id,
          videoId: v.videoId,
          createTime: v.createTime,
          caption: v.caption,
          durationSec: v.durationSec ?? null,
          coverUrl: v.coverUrl && isAllowedCoverUrl(v.coverUrl) ? v.coverUrl : null,
          status: wanted(v.caption) ? "pending" : "skipped_initial",
          // 通知するのは新着として取り込む行だけ (backfill / skip / 絞り込み外は流さない)
          notify: !initial && !backfill && wanted(v.caption),
        })),
        skipDuplicates: true,
      });
    }

    // 既存: 変わったものだけ更新 (毎周 48 本を無条件に書き直さない。15 秒のトランザクションにも収める)。
    // 別の対象に載っている動画 (同じ動画が複数の垢に出ることは無いはずだが) は触らない
    for (const v of input.videos) {
      const e = existingById.get(v.videoId);
      if (!e || e.targetId !== target.id || e.status === "registered") continue;
      const data: Prisma.TiktokVideoUpdateManyMutationInput = {};
      if (v.caption && v.caption !== e.caption) data.caption = v.caption;
      if (v.durationSec != null && v.durationSec !== e.durationSec) data.durationSec = v.durationSec;
      if (v.coverUrl && v.coverUrl !== e.coverUrl && isAllowedCoverUrl(v.coverUrl)) data.coverUrl = v.coverUrl;
      if (Object.keys(data).length === 0) continue;
      await tx.tiktokVideo.update({ where: { videoId: v.videoId }, data });
    }

    if (backfill && ids.length > 0) {
      // 絞り込みがあるときは合うものだけ pending に戻す (createMany と同じ判定をアプリ側で)
      const flip = input.videos
        .filter((v) => captionMatches(v.caption, target.captionFilter))
        .map((v) => v.videoId);
      if (flip.length > 0) {
        await tx.tiktokVideo.updateMany({
          where: { targetId: target.id, videoId: { in: flip }, status: "skipped_initial" },
          data: { status: "pending", attempts: 0, lastError: "" },
        });
      }
    }
    if (skip && ids.length > 0) {
      await tx.tiktokVideo.updateMany({
        where: { targetId: target.id, videoId: { in: ids }, status: "pending" },
        data: { status: "skipped_initial" },
      });
    }

    await tx.tiktokWatchTarget.update({
      where: { id: target.id },
      data: {
        lastCheckedAt: new Date(),
        lastError: "",
        lastErrorAt: null,
        ...(input.secUid ? { secUid: input.secUid } : {}),
        ...(input.videoCount != null ? { videoCount: input.videoCount } : {}),
      },
    });

    const retryBefore = new Date(Date.now() - RETRY_COOLDOWN_MINUTES * 60_000);
    const pendingRows = await tx.tiktokVideo.findMany({
      where: {
        targetId: target.id,
        OR: [
          { status: "pending" },
          { status: "failed", attempts: { lt: MAX_ATTEMPTS }, updatedAt: { lt: retryBefore } },
        ],
      },
      orderBy: { createTime: "desc" },
      take: MAX_PENDING_PER_RESPONSE,
      select: { videoId: true, createTime: true, caption: true, notify: true },
    });

    const grouped = await tx.tiktokVideo.groupBy({
      by: ["status"],
      where: { targetId: target.id },
      _count: { _all: true },
    });
    const counts = emptyCounts();
    for (const g of grouped) counts[g.status] = g._count._all;

    return {
      initial,
      added: toCreate.length,
      pending: pendingRows.map((p) => ({
        videoId: p.videoId,
        url: videoUrl(h, p.videoId),
        createTime: p.createTime,
        caption: p.caption,
        notify: p.notify,
      })),
      counts,
    };
  });
}

/** 巡回そのものの失敗 (profile が開けない等)。次に成功した報告で消える */
export async function reportTiktokTargetError(handle: string, error: string, clearance: string): Promise<void> {
  const h = normalizeHandle(handle);
  await withClearance(clearance, async (tx) => {
    const target = await tx.tiktokWatchTarget.findUnique({ where: { handle: h }, select: { id: true } });
    if (!target) throw new TiktokNotFoundError(`監視対象にありません: ${h}`);
    await tx.tiktokWatchTarget.update({
      where: { id: target.id },
      data: { lastError: error.slice(0, ERROR_MAX), lastErrorAt: new Date() },
    });
  });
}

export interface RegisterResult {
  assetId: string;
  title: string;
  url: string;
  /** キャプションから拾ったメンバー名 (名簿順) */
  members: string[];
  /** 坂井新奈が入っているか (Discord で目立たせる用) */
  highlight: boolean;
  /** Discord に流してよいか (台帳の notify) */
  notify: boolean;
  /** 既に登録済みだった (二度目の呼び出し。通知もしない) */
  alreadyRegistered: boolean;
}

/**
 * bot が `POST /upload` で作ったアセットを TikTok の動画として整える。
 *
 * タイトル・説明・投稿時刻・出典 (SourceRecord + source エンティティ)・メンバー (person
 * エンティティ) を付け、cover 画像があればサムネイルに写す。名簿 (`members.ts`) は akashic
 * だけが持つので、紐付けは bot ではなくここで行う。
 *
 * **先に台帳の行を確保してから整える** (`pending` / `failed` → `registered` を updateMany で
 * 取り合う)。daemon と `watch --once` / backfill が同じ動画を同時に持ってきても、整えるのは
 * 1 回、通知も 1 回になる。確保できなければ `alreadyRegistered` で何もしない
 * (upload の SHA256 dedup で既存アセットが返ることもある)。整える途中で失敗したら行を
 * `failed` に戻して投げる (次の周で再試行)。
 */
export async function registerTiktokVideo(
  videoId: string,
  assetId: string,
  auth: { id: string; clearance: string },
): Promise<RegisterResult> {
  const video = await withClearance(auth.clearance, (tx) =>
    tx.tiktokVideo.findUnique({
      where: { videoId },
      include: { target: { select: { id: true, handle: true, sourceName: true, official: true } } },
    }),
  );
  if (!video) throw new TiktokNotFoundError(`台帳にありません: ${videoId}`);

  const url = videoUrl(video.target.handle, video.videoId);
  const members = extractMemberNames(video.caption);
  const title = deriveTitle(video.caption, video.target.handle, video.createTime);
  const highlight = members.includes(HIGHLIGHT_MEMBER);
  const base = { assetId, title, url, members, highlight, notify: video.notify };

  if (video.status === "registered") {
    if (video.assetId === assetId) return { ...base, alreadyRegistered: true };
    throw new TiktokConflictError(`別のアセット (${video.assetId}) で登録済みです: ${videoId}`);
  }

  const asset = await withClearance(auth.clearance, (tx) =>
    tx.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        thumbnailUrl: true,
        sourceRecords: { select: { url: true } },
        tiktokVideo: { select: { videoId: true } },
      },
    }),
  );
  if (!asset) throw new TiktokNotFoundError(`アセットが見つかりません: ${assetId}`);
  if (asset.tiktokVideo && asset.tiktokVideo.videoId !== videoId) {
    // 同じファイルが別の動画として先に登録されている (upload の dedup で同じアセットが返った)
    throw new TiktokConflictError(
      `このアセットは別の動画 (${asset.tiktokVideo.videoId}) に紐づいています: ${assetId}`,
    );
  }

  // 行を確保する。取れなければ他の呼び出しが先に整えている
  const claimed = await withClearance(auth.clearance, (tx) =>
    tx.tiktokVideo.updateMany({
      where: { videoId, status: { in: ["pending", "failed"] } },
      data: { status: "registered", assetId, registeredAt: new Date(), lastError: "" },
    }),
  );
  if (claimed.count === 0) return { ...base, alreadyRegistered: true };

  try {
    // エンティティ: 出典 (source) と、キャプションに出たメンバー (person)。
    // person は名簿と同名のものが Entity に在る前提 (sync-members が入れている)。無ければ作らない
    const sourceEntity = await findOrCreateEntity("source", sourceEntityName(video.target));
    const memberEntities = members.length
      ? await prisma.entity.findMany({
          where: { type: "person", canonicalName: { in: members } },
          select: { id: true, canonicalName: true },
        })
      : [];

    // cover 画像からサムネイル。署名付き URL は失効するので取れなければ諦める
    // (Drive のサムネイル経由 `pnpm cli:thumbnails --kind=video` が後で埋める)
    let thumbnailUrl: string | undefined;
    if (video.coverUrl && !asset.thumbnailUrl) {
      const cover = await fetchCover(video.coverUrl);
      const r2Url = cover ? await generateAndUploadThumbnails(assetId, cover) : null;
      if (r2Url) thumbnailUrl = r2Url;
    }

    const hasSourceRecord = asset.sourceRecords.some((s) => s.url === url);
    await updateAsset(
      assetId,
      {
        title,
        description: video.caption,
        canonicalDate: video.createTime,
        sourceType: "web",
        ...(video.target.official ? { trustLevel: "official" as const } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        entities: [{ entityId: sourceEntity.id }, ...memberEntities.map((e) => ({ entityId: e.id }))],
        ...(hasSourceRecord
          ? {}
          : {
              sourceRecords: [
                {
                  sourceKind: "url" as const,
                  url,
                  title,
                  publisher: "TikTok",
                  publishedAt: video.createTime,
                  metadata: { handle: video.target.handle, videoId: video.videoId },
                },
              ],
            }),
      },
      auth.id,
      auth.clearance,
    );
  } catch (e) {
    // 確保した行を戻す。次の周で再試行される (attempts は bot の failed 報告で進む)
    await withClearance(auth.clearance, (tx) =>
      tx.tiktokVideo.updateMany({
        where: { videoId, status: "registered", assetId },
        data: {
          status: "failed",
          assetId: null,
          registeredAt: null,
          lastError: (e instanceof Error ? e.message : String(e)).slice(0, ERROR_MAX),
        },
      }),
    ).catch((err) => console.error("TikTok 台帳の巻き戻しに失敗:", err));
    throw e;
  }

  // 外部 bot の取り込みなので一覧だけ無効化する (stats まで飛ばすと dashboard が毎回再集計になる)
  invalidateAssetList();

  return { ...base, alreadyRegistered: false };
}

const COVER_TIMEOUT_MS = 10_000;
const COVER_MAX_BYTES = 5 * 1024 * 1024;

async function fetchCover(coverUrl: string): Promise<Buffer | null> {
  // bot が送った URL をサーバが取りに行くので TikTok の CDN に限る (SSRF 対策)
  if (!isAllowedCoverUrl(coverUrl)) return null;
  try {
    const res = await fetch(coverUrl, { signal: AbortSignal.timeout(COVER_TIMEOUT_MS), redirect: "error" });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > COVER_MAX_BYTES) return null;
    return buf;
  } catch (err) {
    console.error("TikTok cover の取得に失敗:", err);
    return null;
  }
}

export async function markTiktokVideoNotified(videoId: string, clearance: string): Promise<void> {
  const r = await withClearance(clearance, (tx) =>
    tx.tiktokVideo.updateMany({ where: { videoId }, data: { notifiedAt: new Date() } }),
  );
  if (r.count === 0) throw new TiktokNotFoundError(`台帳にありません: ${videoId}`);
}

/**
 * DL か登録の失敗。attempts を進め、上限に達したら人が「再試行」するまで返さなくなる。
 * `registered` の行には効かない (bot 側のタイムアウトで、実は登録が済んでいた行を壊さない)
 */
export async function markTiktokVideoFailed(
  videoId: string,
  error: string,
  clearance: string,
): Promise<{ attempts: number; willRetry: boolean }> {
  return withClearance(clearance, async (tx) => {
    const row = await tx.tiktokVideo.findUnique({
      where: { videoId },
      select: { id: true, attempts: true, status: true },
    });
    if (!row) throw new TiktokNotFoundError(`台帳にありません: ${videoId}`);
    if (row.status === "registered") return { attempts: row.attempts, willRetry: false };
    const attempts = row.attempts + 1;
    await tx.tiktokVideo.update({
      where: { videoId },
      data: { status: "failed", attempts, lastError: error.slice(0, ERROR_MAX) },
    });
    return { attempts, willRetry: attempts < MAX_ATTEMPTS };
  });
}
