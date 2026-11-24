import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withClearance, type TransactionClient } from "@/lib/db";
import { assertClearance } from "@/lib/classification";
import { createResumableUploadSession, getDriveFileMeta, isPrivateSceneFolder } from "@/lib/drive";
import { NINA_ENTITY_ID } from "@/lib/nina";
import {
  ExportRange, SceneManifest, SCENE_VERSION, SCENE_TASK_LEASE_MS, MAX_MEDIA_BYTES,
  type SceneMedia, type SceneView, type VideoScenesView, MEDIA_CHUNK_BYTES,
} from "@/lib/video-scenes/policy";
import { sceneVideoKindWhere, type SceneVideoKind } from "@/lib/video-scenes/filters";

type Actor = { id: string; role: string; clearance: string };
export class SceneInputError extends Error {}
export class SceneNotFoundError extends SceneInputError {}
export class SceneLeaseError extends SceneInputError {}

export function requireSceneEditor(user: Actor) {
  if (!['admin', 'member'].includes(user.role)) throw new SceneInputError("この操作には編集権限が必要です");
}

const videoWhere = { kind: "video" as const, storageProvider: "gdrive" as const, storageKey: { not: null } };
const taskSelect = { id: true, status: true, error: true } as const;
const fileSelect = { id: true, mimeType: true, fileSize: true } as const;
function media(f: { id: string; mimeType: string; fileSize: number | null }): SceneMedia {
  return { ...f, kind: f.mimeType.startsWith("image/") ? "image" : "video" };
}

export async function listSceneVideos(clearance: string, page: number, kind: SceneVideoKind | null = null) {
  return withClearance(clearance, (tx) => tx.asset.findMany({
    where: { ...videoWhere, AND: [{ OR: [
      { entities: { some: { entityId: NINA_ENTITY_ID } } },
      { faceDetections: { some: { confirmedEntityId: NINA_ENTITY_ID } } },
      { videoSceneTasks: { some: {} } },
    ] }, sceneVideoKindWhere(kind)] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 25, skip: (page - 1) * 25,
    select: { id: true, title: true, fileSize: true, thumbnailUrl: true, canonicalDate: true, videoSceneTasks: {
      where: { kind: "analyze", requestKey: { startsWith: `${SCENE_VERSION}:` } },
      take: 1, select: taskSelect,
    } },
  }));
}

export async function getVideoScenes(clearance: string, assetId: string): Promise<VideoScenesView | null> {
  return withClearance(clearance, async (tx) => {
    const asset = await tx.asset.findFirst({ where: { id: assetId, ...videoWhere }, select: { id: true, title: true, fileSize: true } });
    if (!asset) return null;
    const task = await tx.videoSceneTask.findUnique({ where: { requestKey: `${SCENE_VERSION}:analyze:${assetId}` },
      select: { ...taskSelect, result: true, files: { where: { storageKey: { not: null } }, select: { ...fileSelect, slot: true } } } });
    const recent = await tx.videoSceneTask.findMany({ where: { assetId, kind: "export" }, orderBy: { createdAt: "desc" }, take: 20,
      select: { id: true, status: true, startSec: true, endSec: true, result: true, files: { where: { storageKey: { not: null } }, select: fileSelect } } });
    const exports = recent.map((r) => {
      const result = r.result as { fileId?: string };
      const f = r.status === "ready" ? r.files.find((f) => f.id === result.fileId) : null;
      return { id: r.id, status: r.status, start: r.startSec ?? 0, end: r.endSec ?? 0, file: f ? media(f) : null };
    });
    const parsed = SceneManifest.safeParse(task?.result);
    if (!task || !parsed.success) return { asset, task: task ? { id: task.id, status: task.status, error: task.error } : null, duration: null, scenes: [], exports };
    const previews = new Map(task.files.map((f) => [f.slot, f.id]));
    const files = new Map(task.files.map((f) => [f.id, { ...media(f), previewId: previews.get(`thumb-${f.slot}`) }]));
    const scenes: SceneView[] = [];
    for (const scene of parsed.data.scenes) {
      const poster = files.get(scene.posterFileId);
      if (!poster) continue;
      scenes.push({ id: scene.id, start: scene.start, end: scene.end, poster,
        video: scene.videoFileId ? files.get(scene.videoFileId) ?? null : null,
        shots: scene.shots.flatMap((s) => { const f = files.get(s.fileId); return f ? [{ time: s.time, media: f }] : []; }),
      });
    }
    return { asset, task: { id: task.id, status: task.status, error: task.error }, duration: parsed.data.duration, scenes, exports };
  });
}

export async function requestSceneTask(user: Actor, assetId: string, range?: unknown) {
  requireSceneEditor(user);
  const parsed = range === undefined ? null : ExportRange.safeParse(range);
  if (parsed && !parsed.success) throw new SceneInputError(parsed.error.issues[0].message);
  const bounds = parsed?.success ? { start: Math.round(parsed.data.start * 10) / 10, end: Math.round(parsed.data.end * 10) / 10 } : null;
  if (bounds && !ExportRange.safeParse(bounds).success) throw new SceneInputError("保存範囲を確認してください");
  const kind = bounds ? "export" : "analyze";
  const key = `${SCENE_VERSION}:${kind}:${assetId}${bounds ? `:${bounds.start}:${bounds.end}` : ""}`;
  return withClearance(user.clearance, async (tx) => {
    const asset = await tx.asset.findFirst({ where: { id: assetId, ...videoWhere }, select: { classification: true } });
    if (!asset) throw new SceneNotFoundError("動画が見つかりません");
    assertClearance(user.clearance, asset.classification);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    if (bounds) {
      const analysis = await tx.videoSceneTask.findUnique({ where: { requestKey: `${SCENE_VERSION}:analyze:${assetId}` }, select: { result: true } });
      const manifest = SceneManifest.safeParse(analysis?.result);
      if (manifest.success && bounds.end > manifest.data.duration) throw new SceneInputError("動画の長さの範囲内で選んでください");
      // 分析前でも、人が元動画から選んだ範囲を依頼できる。実際の長さはワーカーが ffprobe で確認する。
    }
    const existing = await tx.videoSceneTask.findUnique({ where: { requestKey: key }, select: taskSelect });
    if (existing && existing.status !== "failed") return existing;
    if (existing) return tx.videoSceneTask.update({ where: { id: existing.id }, data: {
      status: "queued", error: null, attempts: 0, leaseToken: null, leaseUntil: null, result: {},
    }, select: taskSelect });
    return tx.videoSceneTask.create({ data: { assetId, requestKey: key, kind, startSec: bounds?.start, endSec: bounds?.end, requestedById: user.id }, select: taskSelect });
  });
}

export async function sceneTaskStatus(clearance: string, taskId: string) {
  return withClearance(clearance, async (tx) => {
    const task = await tx.videoSceneTask.findUnique({ where: { id: taskId }, select: { ...taskSelect, kind: true, result: true } });
    if (!task) return null;
    const result = task.result as { fileId?: string };
    const file = task.kind === "export" && task.status === "ready" && typeof result.fileId === "string"
      ? await tx.videoSceneFile.findFirst({ where: { id: result.fileId, taskId, storageKey: { not: null } }, select: fileSelect }) : null;
    return { id: task.id, status: task.status, error: task.error, file: file ? media(file) : null };
  });
}

/** 待機中は結果の JSON とファイル一覧を毎回送らず、変化したときだけ本体を取り直す。 */
export async function sceneProgress(clearance: string, assetId: string) {
  return withClearance(clearance, async (tx) => {
    const rows = await tx.videoSceneTask.findMany({ where: { assetId,
      OR: [{ requestKey: `${SCENE_VERSION}:analyze:${assetId}` }, { kind: "export" }],
    }, orderBy: [{ kind: "asc" }, { createdAt: "desc" }, { id: "desc" }], take: 21, select: { id: true, status: true, kind: true } });
    return [...rows.filter((r) => r.kind === "analyze"), ...rows.filter((r) => r.kind === "export").slice(0, 20)].map(({ id, status }) => ({ id, status }));
  });
}

export async function claimSceneTask(user: Actor, onlyExport = false) {
  requireSceneEditor(user);
  const task = await withClearance(user.clearance, async (tx) => {
    const now = new Date();
    await tx.videoSceneTask.updateMany({ where: { status: "processing", attempts: { gte: 3 }, leaseUntil: { lt: now } },
      data: { status: "failed", error: "処理が完了しませんでした。もう一度生成してください", leaseToken: null, leaseUntil: null } });
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "VideoSceneTask"
      WHERE attempts < 3 AND (status = 'queued' OR (status = 'processing' AND "leaseUntil" < ${now}))
      ${onlyExport ? Prisma.sql`AND kind = 'export'` : Prisma.empty}
      ORDER BY CASE WHEN kind = 'export' THEN 0 ELSE 1 END, "createdAt", id
      LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!rows[0]) return null;
    return tx.videoSceneTask.update({ where: { id: rows[0].id }, data: {
      status: "processing", leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + SCENE_TASK_LEASE_MS), attempts: { increment: 1 }, error: null,
    }, select: { id: true, kind: true, assetId: true, startSec: true, endSec: true, leaseToken: true,
      files: { where: { storageKey: { not: null } }, select: { id: true } },
      asset: { select: { title: true, classification: true, fileSize: true, storageKey: true, updatedAt: true } } } });
  });
  if (!task) return null;
  // Drive のネットワーク待ちで DB のトランザクションを保持しない。
  const { storageKey, updatedAt, ...asset } = task.asset;
  const sourceMeta = storageKey ? await getDriveFileMeta(storageKey) : null;
  const sourceSha256 = sourceMeta?.sha256 ?? null;
  const sourceRevision = createHash("sha256").update(JSON.stringify([storageKey, updatedAt.toISOString(), asset.fileSize, sourceSha256])).digest("hex");
  return { ...task, asset: { ...asset, sourceRevision, sourceSha256,
    sourceDriveFileId: storageKey, sourceBytes: sourceMeta?.size ?? null } };
}

/** 常駐側が指定したときだけ、新しい本人関連の動画を 1 本ずつ先に処理する。 */
export async function discoverSceneTask(user: Actor) {
  requireSceneEditor(user);
  const asset = await withClearance(user.clearance, (tx) => tx.asset.findFirst({ where: {
    ...videoWhere,
    OR: [{ entities: { some: { entityId: NINA_ENTITY_ID } } }, { faceDetections: { some: { confirmedEntityId: NINA_ENTITY_ID } } }],
    videoSceneTasks: { none: { requestKey: { startsWith: `${SCENE_VERSION}:analyze:` } } },
  }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } }));
  return asset ? requestSceneTask(user, asset.id) : null;
}

async function leased(tx: TransactionClient, taskId: string, token: string) {
  // 完了・期限更新・再取得が競合しても、古いワーカーの書き込みを通さない。
  await tx.$queryRaw`SELECT id FROM "VideoSceneTask" WHERE id = ${taskId} FOR UPDATE`;
  const task = await tx.videoSceneTask.findUnique({ where: { id: taskId }, include: { asset: { select: { classification: true } } } });
  if (!task || task.status !== "processing" || task.leaseToken !== token || !task.leaseUntil || task.leaseUntil <= new Date()) {
    throw new SceneLeaseError("処理の有効期限が切れました");
  }
  return task;
}

export async function updateSceneTask(user: Actor, taskId: string, token: string, operation: "heartbeat" | "fail" | "complete" | "yield", result?: unknown) {
  requireSceneEditor(user);
  return withClearance(user.clearance, async (tx) => {
    const task = await leased(tx, taskId, token);
    if (operation === "heartbeat") {
      await tx.videoSceneTask.update({ where: { id: taskId }, data: { leaseUntil: new Date(Date.now() + SCENE_TASK_LEASE_MS) } });
      return;
    }
    if (operation === "fail") {
      const message = (result as { code?: string })?.code === "source-staging-required"
        ? "Vercelの転送量を抑えるため、元動画の直接取得が必要です"
        : "動画を処理できませんでした。ワーカーのログを確認してください";
      await tx.videoSceneTask.update({ where: { id: taskId }, data: { status: "failed", error: message, leaseToken: null, leaseUntil: null } });
      return;
    }
    if (operation === "yield") {
      if (task.kind !== "analyze") throw new SceneInputError("分析依頼だけを継続できます");
      const previous = task.result as { continuations?: number };
      const continuations = (previous?.continuations ?? 0) + 1;
      if (continuations > 128) throw new SceneInputError("継続処理の上限に達しました");
      await tx.videoSceneTask.update({ where: { id: taskId }, data: {
        status: "queued", attempts: 0, leaseToken: null, leaseUntil: null, result: { continuations },
      } });
      return;
    }
    const files = await tx.videoSceneFile.findMany({ where: { taskId, storageKey: { not: null } }, select: fileSelect });
    const byId = new Map(files.map((f) => [f.id, f]));
    let validated: Prisma.InputJsonValue;
    if (task.kind === "analyze") {
      const parsed = SceneManifest.safeParse(result);
      if (!parsed.success) throw new SceneInputError("場面候補の形式が違います");
      for (const s of parsed.data.scenes) {
        if ((s.videoFileId && byId.get(s.videoFileId)?.mimeType !== "video/mp4") ||
            byId.get(s.posterFileId)?.mimeType !== "image/jpeg" ||
            s.shots.some((sh) => byId.get(sh.fileId)?.mimeType !== "image/jpeg")) {
          throw new SceneInputError("この依頼にアップロードしたファイルだけを指定してください");
        }
      }
      validated = parsed.data;
    } else {
      const fileId = (result as { fileId?: unknown })?.fileId;
      if (typeof fileId !== "string" || byId.get(fileId)?.mimeType !== "video/mp4") throw new SceneInputError("保存用の動画がありません");
      validated = { fileId };
    }
    await tx.videoSceneTask.update({ where: { id: taskId }, data: { status: "ready", result: validated, error: null, leaseToken: null, leaseUntil: null } });
  });
}

export async function initiateSceneFile(user: Actor, taskId: string, token: string, slot: string, mimeType: "image/jpeg" | "video/mp4") {
  requireSceneEditor(user);
  const folderId = process.env.VIDEO_SCENES_DRIVE_FOLDER_ID;
  if (!folderId || !await isPrivateSceneFolder(folderId)) throw new SceneInputError("場面素材の非公開 Drive フォルダを設定してください");
  const file = await withClearance(user.clearance, async (tx) => {
    await leased(tx, taskId, token);
    const [count, existing] = await Promise.all([
      tx.videoSceneFile.count({ where: { taskId } }),
      tx.videoSceneFile.findFirst({ where: { taskId, slot }, select: { id: true } }),
    ]);
    if (count >= 4000 && !existing) throw new SceneInputError("この動画の候補数が上限に達しました");
    const filename = `${taskId}-${slot}.${mimeType === "image/jpeg" ? "jpg" : "mp4"}`;
    return tx.videoSceneFile.upsert({ where: { taskId_slot: { taskId, slot } },
      create: { taskId, slot, filename, mimeType }, update: { filename, mimeType, storageKey: null, fileSize: null } });
  });
  const uploadUrl = await createResumableUploadSession(file.filename, mimeType, folderId, {
    sceneTask: taskId, sceneFile: file.id, sceneLease: createHash("sha256").update(token).digest("hex"),
  });
  if (!uploadUrl) throw new SceneInputError("ファイルの保存先が設定されていません");
  return { fileId: file.id, uploadUrl };
}

export async function completeSceneFile(user: Actor, taskId: string, token: string, fileId: string, driveFileId: string) {
  requireSceneEditor(user);
  const meta = await getDriveFileMeta(driveFileId);
  if (!meta || meta.trashed || !process.env.VIDEO_SCENES_DRIVE_FOLDER_ID || !meta.parents.includes(process.env.VIDEO_SCENES_DRIVE_FOLDER_ID) ||
      meta.appProperties.sceneTask !== taskId || meta.appProperties.sceneFile !== fileId ||
      meta.appProperties.sceneLease !== createHash("sha256").update(token).digest("hex") ||
      meta.size == null || meta.size <= 0 || meta.size > MAX_MEDIA_BYTES ||
      (meta.mimeType === "image/jpeg" && meta.size > MEDIA_CHUNK_BYTES)) {
    throw new SceneInputError("アップロードしたファイルを確認できません");
  }
  return withClearance(user.clearance, async (tx) => {
    await leased(tx, taskId, token);
    const file = await tx.videoSceneFile.findFirst({ where: { id: fileId, taskId } });
    if (!file || file.mimeType !== meta.mimeType) throw new SceneInputError("ファイル形式が一致しません");
    // finalizeDriveUpload は公開権限を作るので使わない。この経路の実体は Drive 内も非公開。
    return tx.videoSceneFile.update({ where: { id: fileId }, data: { storageKey: meta.id, fileSize: meta.size }, select: fileSelect });
  });
}

export async function getSceneFile(clearance: string, fileId: string) {
  return withClearance(clearance, (tx) => tx.videoSceneFile.findFirst({
    where: { id: fileId, storageKey: { not: null }, task: { status: "ready" } },
    select: { id: true, storageKey: true, fileSize: true, mimeType: true, filename: true },
  }));
}

export async function getSceneSource(clearance: string, assetId: string) {
  return withClearance(clearance, (tx) => tx.asset.findFirst({ where: { id: assetId, ...videoWhere },
    select: { id: true, storageKey: true, fileSize: true, mimeType: true, originalFilename: true } }));
}
