import { createHash } from "node:crypto";
import type { InstaStoryJobStatus, Prisma } from "@prisma/client";
import { assertClearance, isAboveClearance } from "@/lib/classification";
import { prismaInternal, withClearance, type TransactionClient } from "@/lib/db";
import { createAsset } from "@/lib/domain/assets";
import { logAudit } from "@/lib/domain/audit";
import { parseDateOnly } from "@/lib/domain/coverage";
import { findOrCreateEntity } from "@/lib/domain/entities";
import {
  createResumableUploadSession,
  downloadFromDrive,
  fetchDriveThumbnail,
  finalizeDriveUpload,
  getDriveFileMeta,
  isDriveEnabled,
  trashDriveFile,
  uploadToDrive,
} from "@/lib/drive";
import {
  DISPATCHER_NOT_CONFIGURED_MESSAGE,
  dispatchInstagramJob,
  isDispatcherConfigured,
  type DispatchResult,
} from "@/lib/insta/dispatch";
import {
  ACTIVE_STATUSES,
  DIRECT_UPLOAD_TOO_LARGE_MESSAGE,
  DISCORD_MAX_FILES,
  InstaJobError,
  MAX_ASSET_LINKS,
  MAX_DIRECT_UPLOAD_BYTES,
  MAX_FILE_BYTES,
  dedupeFilename,
  discordMaxFileBytes,
  formatCompletionMessage,
  parseJobResult,
  parseStoryUrl,
  resolveMimeType,
  staleReason,
  type InstaStoryJobFile,
  type InstaStoryJobResult,
} from "@/lib/insta/jobs";
import { transcodeForDiscord } from "@/lib/insta/transcode";
import { DiscordWebhookError, postDiscordWebhookWithFiles, type DiscordAttachment } from "@/lib/status/discord";
import { guessMimeKind } from "@/lib/mime";
import { generateAndUploadThumbnails } from "@/lib/thumbnails";
import { formatDate, toJstDateOnly } from "@/lib/utils";

/**
 * story ジョブ (#178) の DB まわり。
 *
 * ジョブは iPad 1 台に対する直列キュー。**同時に走らせるのは 1 件だけ**で、
 * complete / error / 失効のたびに次の pending を送る (`dispatchNext`)。状態遷移の
 * 判定や URL の検証は `src/lib/insta/jobs.ts` (純粋・テスト済み) に置き、ここはそれを
 * DB に当てるだけにする。
 *
 * クライアントの使い分け:
 * - 人 / API キーからの読み書き (作成・一覧・iPad の報告) は `withClearance`
 * - キューの操作 (失効・次の送信) は誰の権限でも動くべきなので `prismaInternal`
 *   (cron からも呼ばれる。x-mentions の run と同じ扱い)
 */

export { InstaJobError } from "@/lib/insta/jobs";

/** ジョブと、そこから作る Asset の classification。ワーカーのキーはこれ以上を持つ必要がある */
const JOB_CLASSIFICATION = "internal" as const;

/** story の出どころ。discord-bot の人手リレー経路 (`src/insta_story/`) と同じ名前にそろえる */
const SOURCE_ENTITY_NAME = "日向坂46 Instagram";
const GROUP_TAG_NAME = "日向坂46";

/** 一覧の既定件数と上限 */
export const LIST_DEFAULT_LIMIT = 30;
export const LIST_MAX_LIMIT = 100;

/** dispatchNext の直列化に使う advisory lock のキー (任意の定数) */
const DISPATCH_LOCK_KEY = 0x1a5_0178;

export interface InstaStoryJobView {
  id: string;
  handle: string;
  url: string;
  status: InstaStoryJobStatus;
  dispatchedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string;
  result: InstaStoryJobResult;
  createdAt: Date;
  updatedAt: Date;
  requestedByName: string | null;
}

const SELECT = {
  id: true,
  handle: true,
  url: true,
  status: true,
  dispatchedAt: true,
  startedAt: true,
  completedAt: true,
  error: true,
  result: true,
  createdAt: true,
  updatedAt: true,
  requestedBy: { select: { name: true } },
} satisfies Prisma.InstaStoryJobSelect;

type Row = Prisma.InstaStoryJobGetPayload<{ select: typeof SELECT }>;

function toView(row: Row): InstaStoryJobView {
  return {
    id: row.id,
    handle: row.handle,
    url: row.url,
    status: row.status,
    dispatchedAt: row.dispatchedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
    result: parseJobResult(row.result),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    requestedByName: row.requestedBy?.name ?? null,
  };
}

// ---------------------------------------------------------------- 作成・参照

export interface CreateJobResult {
  job: InstaStoryJobView;
  /** 同じハンドルのジョブが進行中だったので、それを返した */
  existing: boolean;
  /** 作成直後に送った結果。送る番でなければ (前のジョブが走っている) null */
  dispatch: DispatchResult | null;
}

/**
 * ジョブを作って、送れる状態なら iPad に送る。
 *
 * 同じハンドルの進行中ジョブがあればそれを返す (bot は「出現」と「更新」で続けて叩く。
 * 前のが走っている間に 2 件目を積んでも同じ story を 2 回落とすだけ)。
 */
export async function createStoryJob(
  input: { url: string },
  actor: { id: string | null; clearance: string },
): Promise<CreateJobResult> {
  assertInternalDb();
  const parsed = parseStoryUrl(input.url);
  // RLS の INSERT ポリシーに当たると素の Prisma エラー (500) になるので、先にアプリ層で 403 にする
  try {
    assertClearance(actor.clearance, JOB_CLASSIFICATION);
  } catch {
    throw new InstaJobError("Forbidden", 403);
  }

  const { row, existing } = await withClearance(actor.clearance, async (tx) => {
    // 同じハンドルの作成を直列化する (bot の「出現」と「更新」が同時に来ても 2 件作らない)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"insta_story_job:" + parsed.handle}))`;
    const active = await tx.instaStoryJob.findFirst({
      where: { handle: parsed.handle, status: { in: [...ACTIVE_STATUSES] } },
      orderBy: { createdAt: "asc" },
      select: SELECT,
    });
    if (active) return { row: active, existing: true };
    const created = await tx.instaStoryJob.create({
      data: { handle: parsed.handle, url: parsed.url, requestedById: actor.id },
      select: SELECT,
    });
    return { row: created, existing: false };
  });

  if (existing) {
    // 送れずに pending のまま残っているなら、この呼び出しを機に送り直す (cron を待たない)
    if (row.status === "pending") await tickStoryJobs();
    const fresh = await getStoryJob(row.id, actor.clearance);
    return { job: fresh ?? toView(row), existing: true, dispatch: null };
  }

  await logAudit({
    actorId: actor.id,
    action: "insta.job.create",
    targetType: "InstaStoryJob",
    targetId: row.id,
    metadata: { handle: parsed.handle, url: parsed.url },
  });

  // 作った直後に送る番なら送る。前のジョブが走っていればそれの完了時に拾われる
  const tick = await tickStoryJobs();
  const dispatched = !tick.dispatcherConfigured
    ? { ok: false as const, error: DISPATCHER_NOT_CONFIGURED_MESSAGE }
    : tick.dispatchedId === row.id
      ? tick.dispatch
      : null;
  const fresh = await getStoryJob(row.id, actor.clearance);
  return { job: fresh ?? toView(row), existing: false, dispatch: dispatched };
}

export async function listStoryJobs(
  opts: { status?: InstaStoryJobStatus; handle?: string; limit?: number },
  clearance: string,
): Promise<InstaStoryJobView[]> {
  const limit = Math.min(Math.max(opts.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const rows = await withClearance(clearance, (tx) =>
    tx.instaStoryJob.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.handle ? { handle: opts.handle } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: SELECT,
    }),
  );
  return rows.map(toView);
}

export async function getStoryJob(id: string, clearance: string): Promise<InstaStoryJobView | null> {
  const row = await withClearance(clearance, (tx) => tx.instaStoryJob.findUnique({ where: { id }, select: SELECT }));
  return row ? toView(row) : null;
}

// ---------------------------------------------------------------- iPad からの報告

/**
 * iPad が受け取ったことの報告。dispatched → processing。
 *
 * 冪等: すでに processing なら何もしない。pending からも通す (Pushcut を経ずに手で Shortcut を
 * 走らせたとき)。終わったジョブには 409。
 */
export async function startStoryJob(id: string, clearance: string): Promise<InstaStoryJobView> {
  return withClearance(clearance, async (tx) => {
    const row = await requireJob(tx, id);
    if (row.status === "processing") return toView(row);
    if (row.status !== "dispatched" && row.status !== "pending") {
      throw new InstaJobError(`このジョブは ${row.status} です`, 409);
    }
    const updated = await tx.instaStoryJob.update({
      where: { id },
      data: { status: "processing", startedAt: new Date() },
      select: SELECT,
    });
    return toView(updated);
  });
}

/**
 * iPad が Drive に直接 PUT するための URL を発行する。
 * Vercel の本文上限 (4.5MB) を避けるため、動画はこの経路で受ける。
 */
export async function createStoryUploadUrl(
  id: string,
  input: { filename: string; mimeType: string },
  clearance: string,
): Promise<{ uploadUrl: string; mimeType: string }> {
  await withClearance(clearance, async (tx) => {
    const row = await requireJob(tx, id);
    await ensureProcessing(tx, row);
    // 大きい動画の PUT が長引いても「報告が途絶えた」と見なさないよう、ここも最終活動として刻む
    await tx.$executeRaw`UPDATE "InstaStoryJob" SET "updatedAt" = NOW() WHERE "id" = ${id}`;
  });
  const mimeType = resolveMimeType(input.mimeType, input.filename);
  if (!isDriveEnabled()) throw new InstaJobError("Google Drive が未設定です", 503);
  const uploadUrl = await createResumableUploadSession(safeFilename(input.filename), mimeType);
  if (!uploadUrl) throw new InstaJobError("Drive のアップロード URL を発行できませんでした", 502);
  return { uploadUrl, mimeType };
}

export type StoryFileSource =
  | { kind: "drive"; driveFileId: string; filename: string; mimeType: string | null; fileSize: number | null }
  | { kind: "buffer"; buffer: Buffer; filename: string; mimeType: string | null };

export interface RegisterFileResult {
  job: InstaStoryJobView;
  file: InstaStoryJobFile;
}

/**
 * 落としたファイル 1 件を Asset にしてジョブに記録する。
 *
 * 登録の形は discord-bot の人手リレー経路にそろえる (kind は MIME から、sourceType=web、
 * タグ「日向坂46」+ source「日向坂46 Instagram」)。**人物は付けない** — 公式垢の story が
 * 全部落ちてくるので、誰が写っているかは /inbox で人が見る (status=inbox)。
 *
 * 同じ実体が既にあれば (SHA256) 新しい Asset は作らず duplicate として記録する。
 */
export async function registerStoryFile(
  id: string,
  source: StoryFileSource,
  actor: { id: string; clearance: string },
): Promise<RegisterFileResult> {
  assertInternalDb();
  const job = await withClearance(actor.clearance, async (tx) => {
    const row = await requireJob(tx, id);
    return ensureProcessing(tx, row);
  });

  const filename = safeFilename(source.filename);
  const mimeType = resolveMimeType(source.mimeType, filename);
  const kind = guessMimeKind(mimeType);

  // 実体は必要になるまで落とさない。Drive 経路は Drive が計算した SHA256 とサイズで判定でき、
  // 本体を読むのは画像のサムネイルを作るときだけ (動画を 200MB まで丸ごと読んでいたのをやめた。#182)
  let sha256: string;
  let fileSize: number;
  let cachedBuffer: Buffer | null = null;
  const getBuffer = async (): Promise<Buffer> => {
    if (cachedBuffer) return cachedBuffer;
    if (source.kind === "buffer") return (cachedBuffer = source.buffer);
    const downloaded = await downloadFromDrive(source.driveFileId).catch(() => null);
    if (!downloaded) throw new InstaJobError("Drive からファイルを読めませんでした", 502);
    return (cachedBuffer = downloaded);
  };

  if (!isDriveEnabled()) throw new InstaJobError("Google Drive が未設定です", 503);
  if (source.kind === "buffer") {
    if (source.buffer.length > MAX_DIRECT_UPLOAD_BYTES) {
      throw new InstaJobError(DIRECT_UPLOAD_TOO_LARGE_MESSAGE, 413);
    }
    fileSize = source.buffer.length;
    sha256 = createHash("sha256").update(source.buffer).digest("hex");
  } else {
    // 申告サイズで先に弾く (Drive を見に行く前)
    if (source.fileSize != null && source.fileSize > MAX_FILE_BYTES) {
      throw new InstaJobError("ファイルが大きすぎます", 413);
    }
    const meta = await getDriveFileMeta(source.driveFileId);
    if (!meta) throw new InstaJobError("Drive にそのファイルがありません (upload-url への PUT が終わっていない?)", 502);
    // upload-url で発行した先 (このアプリのフォルダ、このジョブの後に作られたもの) しか信用しない。
    // 任意の driveFileId を渡されて、別のファイルを公開・登録する口にしない
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID ?? "";
    const since = (job.startedAt ?? job.createdAt).getTime() - 60_000;
    if (
      meta.trashed ||
      !meta.parents.includes(folderId) ||
      !meta.createdTime ||
      meta.createdTime.getTime() < since
    ) {
      throw new InstaJobError("そのファイルは upload-url で発行した先のものではありません");
    }
    // サイズは本体を読む前に判定する (本体を読むのは Drive が SHA256 をまだ出していないときだけ)
    if (meta.size != null && meta.size > MAX_FILE_BYTES) throw new InstaJobError("ファイルが大きすぎます", 413);
    if (meta.sha256 && meta.size != null) {
      sha256 = meta.sha256.toLowerCase();
      fileSize = meta.size;
    } else {
      const buf = await getBuffer();
      fileSize = buf.length;
      sha256 = createHash("sha256").update(buf).digest("hex");
    }
  }
  if (fileSize > MAX_FILE_BYTES) throw new InstaJobError("ファイルが大きすぎます", 413);
  if (fileSize === 0) throw new InstaJobError("空のファイルです");

  // 重複は SHA256 で見るが、それだけでは足りない。Instagram Download は同じ story を落とし直すと
  // ファイル名とサイズは同じでも中身のバイト列が変わる (変換のたびに違う。2026-09-22 実測)。
  // 名前は投稿時刻から付く (`<handle> 2026-09-21T203634.mp4`) ので、同じハンドルの同じ名前は同じコマとみなす。
  // 保存先に同名が残っていると `-2` が付くので、それを落とした名前で比べ、Asset にもその名前で残す
  const dedupeName = dedupeFilename(filename);
  const existing =
    (await prismaInternal.asset.findFirst({
      where: { sha256 },
      select: { id: true, classification: true, storageKey: true },
    })) ??
    (await prismaInternal.asset.findFirst({
      where: {
        originalFilename: dedupeName,
        sourceRecords: { some: { metadata: { path: ["handle"], equals: job.handle } } },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, classification: true, storageKey: true },
    }));
  let file: InstaStoryJobFile;
  if (existing) {
    // ジョブ (internal) に上位機密の Asset の ID / ハッシュを写さない。
    // キーの持ち主が見える範囲でも、ジョブ経由で internal に降りてしまうため
    if (isAboveClearance(existing.classification, JOB_CLASSIFICATION)) {
      throw new InstaJobError("Forbidden", 403);
    }
    try {
      assertClearance(actor.clearance, existing.classification);
    } catch {
      throw new InstaJobError("Forbidden", 403);
    }
    if (source.kind === "drive") {
      // 上げてもらった実体は要らないのでゴミ箱へ (孤児を残さない。30 日は戻せる)。
      // **ただし、どれかの Asset がその ID を実体として指しているなら触らない。**
      // 同じ driveFileId で result を再送されると (Shortcut のリトライ)、直前に作った Asset の
      // 原本を消してしまうため
      const referenced =
        existing.storageKey === source.driveFileId ||
        (await prismaInternal.asset.count({ where: { storageKey: source.driveFileId } })) > 0;
      if (!referenced) {
        await trashDriveFile(source.driveFileId).catch((e) => console.warn("insta job: 重複ファイルの片付けに失敗:", e));
      }
    }
    file = {
      assetId: existing.id,
      duplicate: true,
      driveFileId: null,
      filename,
      mimeType,
      fileSize,
      sha256,
      receivedAt: new Date().toISOString(),
    };
  } else {
    let storageKey: string;
    let storageUrl: string;
    if (source.kind === "drive") {
      const finalized = await finalizeDriveUpload(source.driveFileId);
      storageKey = finalized.fileId;
      storageUrl = finalized.webViewLink;
    } else {
      const uploaded = await uploadToDrive(await getBuffer(), filename, mimeType);
      if (!uploaded) throw new InstaJobError("Drive へのアップロードに失敗しました", 502);
      storageKey = uploaded.fileId;
      storageUrl = uploaded.webViewLink;
    }

    const { tag, sourceEntity } = await storyEntities();
    // Entity が消されていた (merge-entities 等) ときは FK で落ちるので、メモを捨てて 1 回だけ引き直す
    const asset = await createAssetWithStoryEntities(async () => createAsset(
      {
        kind,
        classification: "internal",
        title: `${job.handle} story ${formatDate(job.createdAt, true)}`,
        description: "",
        status: "inbox",
        sourceType: "web",
        storageProvider: "gdrive",
        storageUrl,
        storageKey,
        sha256,
        originalFilename: dedupeName,
        mimeType,
        fileSize,
        thumbnailUrl: kind === "image" ? storageUrl : null,
        // story の撮影時刻は取れないので、検知してジョブを作った日 (JST) を使う。
        // canonicalDate は「YYYY-MM-DD の UTC 00:00」で持つ規約 (時刻付きで入れると UTC で切る
        // 読み手が 1 日ずらす)
        canonicalDate: parseDateOnly(toJstDateOnly(job.createdAt)),
        entities: [
          { entityId: tag.id, roleLabel: "" },
          { entityId: sourceEntity.id, roleLabel: "" },
        ],
        sourceRecords: [
          {
            sourceKind: "url",
            title: `${job.handle} story`,
            url: job.url,
            publisher: "Instagram",
            publishedAt: job.createdAt,
            metadata: { instaStoryJobId: job.id, handle: job.handle },
          },
        ],
      },
      actor.id,
      actor.clearance,
    ));

    // サムネイル。画像は原本から、動画は Drive の生成物から (直後は無いことが多い。
    // 取れなければ `pnpm cli:thumbnails --kind=video` で後から埋める)
    try {
      const src = kind === "image" ? await getBuffer() : await fetchDriveThumbnail(storageKey);
      const r2Url = src ? await generateAndUploadThumbnails(asset.id, src) : null;
      if (r2Url) {
        await withClearance(actor.clearance, (tx) =>
          tx.asset.update({ where: { id: asset.id }, data: { thumbnailUrl: r2Url } }),
        );
      }
    } catch (e) {
      console.error("insta job: サムネイル生成に失敗:", e);
    }

    await logAudit({
      actorId: actor.id,
      action: "asset.create_insta_story",
      targetType: "Asset",
      targetId: asset.id,
      metadata: { jobId: job.id, handle: job.handle, filename, sha256 },
    });

    file = {
      assetId: asset.id,
      duplicate: false,
      driveFileId: storageKey,
      filename,
      mimeType,
      fileSize,
      sha256,
      receivedAt: new Date().toISOString(),
    };
  }

  // files への追記は jsonb の結合で行う (読んで書き戻すと、並んで届いた 2 件が片方を消す)
  const updated = await withClearance(actor.clearance, async (tx) => {
    await tx.$executeRaw`
      UPDATE "InstaStoryJob"
      SET "result" = jsonb_set("result", '{files}', COALESCE("result"->'files', '[]'::jsonb) || ${JSON.stringify([file])}::jsonb),
          "updatedAt" = NOW()
      WHERE "id" = ${id}`;
    return requireJob(tx, id);
  });
  return { job: toView(updated), file };
}

export interface CompleteJobResult {
  job: InstaStoryJobView;
  /** Discord に流す番か (completed になり、webhook が設定されている)。実際の送信は呼び出し側が after() で行う */
  shouldNotify: boolean;
  /** 続けて送った次のジョブ */
  next: TickResult;
}

/**
 * iPad からの完了報告。ファイルが 1 件も無ければ failed にする (Shortcut が何も落とせなかった)。
 *
 * Discord への通知はここでは**やらない**。動画の変換と添付で数十秒〜数分かかるので、応答を返した
 * 後に `notifyStoryJobCompleted` を after() で走らせる (route 側)。iPad の Shortcut は
 * 応答を待っているだけなので、待たせない。
 */
export async function completeStoryJob(id: string, clearance: string): Promise<CompleteJobResult> {
  assertInternalDb();
  let alreadyCompleted = false;
  const job = await withClearance(clearance, async (tx) => {
    const row = await requireJob(tx, id);
    if (row.status === "completed") {
      alreadyCompleted = true;
      return toView(row);
    }
    if (row.status === "failed") throw new InstaJobError("このジョブは failed です", 409);
    const files = parseJobResult(row.result).files;
    const now = new Date();
    const updated = await tx.instaStoryJob.update({
      where: { id },
      data:
        files.length === 0
          ? { status: "failed", completedAt: now, error: "ファイルが 1 件も届きませんでした" }
          : { status: "completed", completedAt: now, error: "" },
      select: SELECT,
    });
    return toView(updated);
  });

  // iPad は completed になった時点で空くので、先に次のジョブを送る
  const next = await tickStoryJobs();
  // 既に completed だった (冪等の再送) ときは通知し直さない
  const shouldNotify = job.status === "completed" && !alreadyCompleted && isInstaDiscordConfigured();
  return { job, shouldNotify, next };
}

/** iPad からの失敗報告 */
export async function failStoryJob(
  id: string,
  error: string,
  clearance: string,
): Promise<{ job: InstaStoryJobView; next: TickResult }> {
  const job = await withClearance(clearance, async (tx) => {
    const row = await requireJob(tx, id);
    if (row.status === "completed" || row.status === "failed") {
      throw new InstaJobError(`このジョブは ${row.status} です`, 409);
    }
    const updated = await tx.instaStoryJob.update({
      where: { id },
      data: { status: "failed", completedAt: new Date(), error: error.trim().slice(0, 500) || "iPad が失敗を報告" },
      select: SELECT,
    });
    return toView(updated);
  });
  const next = await tickStoryJobs();
  return { job, next };
}

// ---------------------------------------------------------------- キュー

export interface TickResult {
  /** 失効させたジョブの ID */
  expired: string[];
  /** 今回 iPad に送ったジョブ。送る番のジョブが無ければ null */
  dispatchedId: string | null;
  dispatch: DispatchResult | null;
  dispatcherConfigured: boolean;
}

/**
 * キューを 1 回進める。失効したジョブを failed にし、走っているジョブが無ければ
 * 最古の pending を iPad に送る。作成・完了・失敗のたびと `/api/cron/status` (15 分ごと) から呼ぶ。
 *
 * 送るジョブの選択は advisory lock で直列化する (bot の作成と iPad の完了が同時に来ても
 * 2 件を送らない)。Pushcut への HTTP はロックの外で行い、失敗したら pending に戻す。
 */
export async function tickStoryJobs(now: Date = new Date()): Promise<TickResult> {
  assertInternalDb();
  const expired = await expireStaleJobs(now);
  const configured = isDispatcherConfigured();
  if (!configured) return { expired, dispatchedId: null, dispatch: null, dispatcherConfigured: false };

  const claimed = await prismaInternal.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DISPATCH_LOCK_KEY})`;
    const running = await tx.instaStoryJob.count({ where: { status: { in: ["dispatched", "processing"] } } });
    if (running > 0) return null;
    const next = await tx.instaStoryJob.findFirst({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      select: { id: true, url: true, handle: true },
    });
    if (!next) return null;
    await tx.instaStoryJob.update({
      where: { id: next.id },
      data: { status: "dispatched", dispatchedAt: now, error: "" },
    });
    return next;
  });
  if (!claimed) return { expired, dispatchedId: null, dispatch: null, dispatcherConfigured: true };

  const dispatch = await dispatchInstagramJob(claimed);
  if (!dispatch.ok) {
    // 送れなかったら pending に戻して理由を残す。次の tick でまた試す。
    // status を条件に入れるのは、タイムアウト後に実は届いていて iPad が start を叩いた
    // (= processing になった) ジョブを pending に巻き戻さないため
    await prismaInternal.instaStoryJob.updateMany({
      where: { id: claimed.id, status: "dispatched" },
      data: { status: "pending", dispatchedAt: null, error: `送信に失敗: ${dispatch.error.slice(0, 300)}` },
    });
  }
  return { expired, dispatchedId: claimed.id, dispatch, dispatcherConfigured: true };
}

async function expireStaleJobs(now: Date): Promise<string[]> {
  const active = await prismaInternal.instaStoryJob.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] } },
    select: { id: true, status: true, createdAt: true, dispatchedAt: true, startedAt: true, updatedAt: true },
  });
  const expired: string[] = [];
  for (const job of active) {
    const reason = staleReason(job, now);
    if (!reason) continue;
    // 読んでから書くまでの間に iPad が完了させていたら触らない (status を条件に入れる)
    const res = await prismaInternal.instaStoryJob.updateMany({
      where: { id: job.id, status: job.status },
      data: { status: "failed", completedAt: now, error: reason },
    });
    if (res.count > 0) expired.push(job.id);
  }
  return expired;
}

// ---------------------------------------------------------------- Discord

export function isInstaDiscordConfigured(): boolean {
  return !!process.env.DISCORD_INSTA_WEBHOOK_URL?.trim();
}

function appUrl(path: string): string {
  const base = process.env.AUTH_URL?.trim().replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

export interface NotifyResult {
  notified: boolean;
  attached: number;
  error: string | null;
}

/**
 * 完了を Discord に流す。新規に登録した実体を添付する (10 件まで。超えたぶんは本文のリンクから辿れる)。
 *
 * - 動画は Instagram の VP9 のままだと Discord で再生できないので、Discord 用に H.264 / 幅 720 へ
 *   変換して添付する (元の Asset は原本のまま)。変換に失敗したら添付しない
 * - 添付の上限は `discordMaxFileBytes()` (既定 10MB = ブースト無し)。それでも Discord が 413 で弾いたら
 *   大きい順に外して送り直す (サーバのブースト状況を知らなくても通る)
 * - 失敗はジョブの error に残す (completed のまま)。webhook 未設定なら何もしない
 *
 * 応答を返した後 (after) に走らせる前提。数十秒〜数分かかる。
 */
export async function notifyStoryJobCompleted(job: InstaStoryJobView): Promise<NotifyResult> {
  const url = process.env.DISCORD_INSTA_WEBHOOK_URL?.trim();
  if (!url) return { notified: false, attached: 0, error: null };

  const fresh = job.result.files.filter((f) => !f.duplicate);
  const content = formatCompletionMessage({
    handle: job.handle,
    url: job.url,
    files: job.result.files,
    assetLinks: fresh.slice(0, MAX_ASSET_LINKS).map((f) => appUrl(`/assets/${f.assetId}`)),
  });

  try {
    const maxBytes = discordMaxFileBytes();
    let attachments: DiscordAttachment[] = [];
    for (const f of fresh) {
      if (attachments.length >= DISCORD_MAX_FILES) break;
      if (!f.driveFileId) continue;
      const data = await downloadFromDrive(f.driveFileId).catch(() => null);
      if (!data) continue;
      let att: DiscordAttachment = { filename: f.filename, data, contentType: f.mimeType };
      if (f.mimeType.startsWith("video/")) {
        try {
          const t = await transcodeForDiscord(data, f.filename);
          att = { filename: t.filename, data: t.data, contentType: t.contentType };
        } catch (e) {
          console.warn("insta job: Discord 用の変換に失敗 (添付しない):", e);
          continue;
        }
      }
      if (att.data.length > maxBytes) continue;
      attachments.push(att);
    }

    // 413 (添付が大きすぎる) は大きい順に外して送り直す
    for (;;) {
      try {
        await postDiscordWebhookWithFiles(url, content, attachments);
        break;
      } catch (e) {
        if (!(e instanceof DiscordWebhookError) || e.status !== 413 || attachments.length === 0) throw e;
        const largest = attachments.reduce((a, b) => (b.data.length > a.data.length ? b : a));
        attachments = attachments.filter((a) => a !== largest);
      }
    }
    return { notified: true, attached: attachments.length, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("insta job: Discord 通知に失敗:", e);
    await prismaInternal.instaStoryJob
      .update({ where: { id: job.id }, data: { error: `Discord 通知に失敗: ${message.slice(0, 200)}` } })
      .catch(() => {});
    return { notified: false, attached: 0, error: message };
  }
}

// ---------------------------------------------------------------- 内部

/** 毎ファイル 2 回 upsert していたのを 1 度だけに。失敗したら次回また引く */
let storyEntitiesPromise: Promise<{ tag: { id: string }; sourceEntity: { id: string } }> | null = null;
function storyEntities() {
  storyEntitiesPromise ??= Promise.all([
    findOrCreateEntity("tag", GROUP_TAG_NAME),
    findOrCreateEntity("source", SOURCE_ENTITY_NAME),
  ])
    .then(([tag, sourceEntity]) => ({ tag, sourceEntity }))
    .catch((e) => {
      storyEntitiesPromise = null;
      throw e;
    });
  return storyEntitiesPromise;
}

/**
 * メモした Entity が消されていると (`pnpm cli:merge-entities` 等) createAsset が FK 違反 (P2003) で落ちる。
 * そのときはメモを捨てて呼び出し側にもう 1 度組み立てさせる
 */
async function createAssetWithStoryEntities<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (e) {
    if ((e as { code?: string }).code === "P2003" && storyEntitiesPromise) {
      storyEntitiesPromise = null;
      return create();
    }
    throw e;
  }
}

/**
 * prismaInternal は DIRECT_URL が無いと DATABASE_URL (app_runtime) に無言で落ち、RLS で 0 行になる
 * (重複判定が効かず二重登録、キューは「送るジョブはありません」と成功報告)。入口で fail-loud にする
 */
function assertInternalDb(): void {
  if (!process.env.DIRECT_URL?.trim()) throw new Error("DIRECT_URL が未設定です (story ジョブは prismaInternal を使う)");
}

async function requireJob(tx: TransactionClient, id: string): Promise<Row> {
  const row = await tx.instaStoryJob.findUnique({ where: { id }, select: SELECT });
  if (!row) throw new InstaJobError("ジョブが見つかりません", 404);
  return row;
}

/** iPad からの報告は processing でだけ受ける。dispatched なら start を省いたとみなして進める */
async function ensureProcessing(tx: TransactionClient, row: Row): Promise<InstaStoryJobView> {
  if (row.status === "processing") return toView(row);
  if (row.status === "dispatched" || row.status === "pending") {
    const updated = await tx.instaStoryJob.update({
      where: { id: row.id },
      data: { status: "processing", startedAt: new Date() },
      select: SELECT,
    });
    return toView(updated);
  }
  throw new InstaJobError(`このジョブは ${row.status} です`, 409);
}

/** ファイル名はそのまま Drive と Asset に載るので、パス区切りと制御文字を落として長さを抑える */
function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/\0-\x1f\x7f]/g, "_")
    .trim()
    .slice(0, 120);
  return cleaned || "story";
}
