import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(), $queryRaw: vi.fn(),
    asset: { findFirst: vi.fn() },
    videoSceneTask: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    videoSceneFile: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  };
  return { tx, getDriveFileMeta: vi.fn(), createResumableUploadSession: vi.fn(), isPrivateSceneFolder: vi.fn(), withClearance: vi.fn(async (_clearance, fn) => fn(tx)) };
});
vi.mock("@/lib/db", () => ({ withClearance: mocks.withClearance }));
vi.mock("@/lib/drive", () => ({ getDriveFileMeta: mocks.getDriveFileMeta, createResumableUploadSession: mocks.createResumableUploadSession, isPrivateSceneFolder: mocks.isPrivateSceneFolder }));
import { requestSceneTask, requireSceneEditor, updateSceneTask, completeSceneFile, initiateSceneFile, sceneProgress, claimSceneTask, SceneLeaseError } from "./video-scenes";

const actor = { id: "member", role: "member", clearance: "internal" };
const token = "e59d286e-d029-44cb-9fb3-9b59555c33e4";
const task = () => ({ id: "task", kind: "analyze", status: "processing", leaseToken: token, leaseUntil: new Date(Date.now() + 60_000), asset: { classification: "internal" } });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("VIDEO_SCENES_DRIVE_FOLDER_ID", "private-folder"); mocks.isPrivateSceneFolder.mockResolvedValue(true); mocks.tx.$queryRaw.mockResolvedValue([{ id: "task" }]); });
afterEach(() => vi.unstubAllEnvs());

describe("場面生成の権限と重複", () => {
  it("viewer は依頼を作れない", async () => {
    expect(() => requireSceneEditor({ ...actor, role: "viewer" })).toThrow();
    await expect(requestSceneTask({ ...actor, role: "viewer" }, "asset")).rejects.toThrow();
    expect(mocks.withClearance).not.toHaveBeenCalled();
  });
  it("RLS で見えない動画には依頼を作れない", async () => {
    mocks.tx.asset.findFirst.mockResolvedValue(null);
    await expect(requestSceneTask(actor, "hidden")).rejects.toThrow("見つかりません");
    expect(mocks.tx.videoSceneTask.create).not.toHaveBeenCalled();
  });
  it("同じ範囲は既存の依頼を使い、連打しても新しい動画を作らない", async () => {
    mocks.tx.asset.findFirst.mockResolvedValue({ classification: "internal" });
    mocks.tx.videoSceneTask.findUnique.mockResolvedValueOnce({ result: { duration: 200, scenes: [] } }).mockResolvedValueOnce({ id: "old", status: "ready", error: null });
    expect(await requestSceneTask(actor, "asset", { start: 10, end: 20 })).toEqual({ id: "old", status: "ready", error: null });
    expect(mocks.tx.$executeRaw).toHaveBeenCalled();
    expect(mocks.tx.videoSceneTask.create).not.toHaveBeenCalled();
  });
  it("動画の長さを超える保存範囲は書き込まない", async () => {
    mocks.tx.asset.findFirst.mockResolvedValue({ classification: "internal" });
    mocks.tx.videoSceneTask.findUnique.mockResolvedValue({ result: { duration: 15, scenes: [] } });
    await expect(requestSceneTask(actor, "asset", { start: 10, end: 20 })).rejects.toThrow("動画の長さ");
    expect(mocks.tx.videoSceneTask.create).not.toHaveBeenCalled();
  });
  it("通し見で選んだ範囲は、分析の完了を待たずに依頼できる", async () => {
    mocks.tx.asset.findFirst.mockResolvedValue({ classification: "internal" });
    mocks.tx.videoSceneTask.findUnique.mockResolvedValue(null);
    mocks.tx.videoSceneTask.create.mockResolvedValue({ id: "export", status: "queued", error: null });
    expect((await requestSceneTask(actor, "asset", { start: 5, end: 12 })).status).toBe("queued");
    expect(mocks.tx.videoSceneTask.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "export", startSec: 5, endSec: 12 }) }));
  });
  it("分析前でも、進捗照会は一覧と同じ直近 20 件にそろえる", async () => {
    mocks.tx.videoSceneTask.findMany.mockResolvedValue(Array.from({ length: 21 }, (_, i) => ({ id: `e${i}`, status: "ready", kind: "export" })));
    expect(await sceneProgress("internal", "asset")).toHaveLength(20);
  });
});

describe("ワーカーの期限と生成物の検査", () => {
  it("再開用の版は返すが、元動画の Drive キーは返さない", async () => {
    mocks.getDriveFileMeta.mockResolvedValue({ sha256: "a".repeat(64) });
    mocks.tx.videoSceneTask.update.mockResolvedValue({ id: "task", asset: { title: "動画", classification: "internal", fileSize: 800_000_000, storageKey: "private-drive-key", updatedAt: new Date("2026-11-20T00:00:00Z") } });
    const result = await claimSceneTask(actor);
    expect(result?.asset.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.asset.sourceSha256).toBe("a".repeat(64));
    expect(result?.asset).not.toHaveProperty("storageKey");
    expect(result?.asset).not.toHaveProperty("updatedAt");
  });
  it("同じ依頼の正しい生成物だけで ready にできる", async () => {
    mocks.tx.videoSceneTask.findUnique.mockResolvedValue(task());
    mocks.tx.videoSceneFile.findMany.mockResolvedValue([{ id: "photo", mimeType: "image/jpeg", fileSize: 1000 }]);
    const result = { duration: 20, scenes: [{ id: "s", start: 0, end: 20, videoFileId: null, posterFileId: "photo", shots: [{ fileId: "photo", time: 5 }] }] };
    await updateSceneTask(actor, "task", token, "complete", result);
    expect(mocks.tx.videoSceneTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ready", result, leaseToken: null }) }));
  });
  it("古いワーカーの結果は別のワーカーの結果を上書きしない", async () => {
    mocks.tx.videoSceneTask.findUnique.mockResolvedValue({ ...task(), leaseToken: "other" });
    await expect(updateSceneTask(actor, "task", token, "complete", {})).rejects.toBeInstanceOf(SceneLeaseError);
    expect(mocks.tx.videoSceneTask.update).not.toHaveBeenCalled();
  });
  it("期限を過ぎた処理は heartbeat でも復活しない", async () => {
    mocks.tx.videoSceneTask.findUnique.mockResolvedValue({ ...task(), leaseUntil: new Date(0) });
    await expect(updateSceneTask(actor, "task", token, "heartbeat")).rejects.toBeInstanceOf(SceneLeaseError);
  });
  it("別の依頼のファイルを場面に混ぜられない", async () => {
    mocks.tx.videoSceneTask.findUnique.mockResolvedValue(task());
    mocks.tx.videoSceneFile.findMany.mockResolvedValue([]);
    await expect(updateSceneTask(actor, "task", token, "complete", { duration: 20, scenes: [{ id: "s", start: 0, end: 10, videoFileId: null, posterFileId: "foreign", shots: [{ fileId: "foreign", time: 5 }] }] })).rejects.toThrow("この依頼");
    expect(mocks.tx.videoSceneTask.update).not.toHaveBeenCalled();
  });
  it("動画ファイルをスクショに偽装できない", async () => {
    mocks.tx.videoSceneTask.findUnique.mockResolvedValue(task());
    mocks.tx.videoSceneFile.findMany.mockResolvedValue([{ id: "fake", mimeType: "video/mp4", fileSize: 10 }]);
    await expect(updateSceneTask(actor, "task", token, "complete", { duration: 20, scenes: [{ id: "s", start: 0, end: 10, videoFileId: null, posterFileId: "fake", shots: [{ fileId: "fake", time: 5 }] }] })).rejects.toThrow();
  });
  it("公開権限を作らず、期限とファイルに結びつくアップロードを作る", async () => {
    mocks.tx.videoSceneTask.findUnique.mockResolvedValue(task());
    mocks.tx.videoSceneFile.findMany.mockResolvedValue([]);
    mocks.tx.videoSceneFile.upsert.mockResolvedValue({ id: "file", filename: "task-S1.jpg" });
    mocks.createResumableUploadSession.mockResolvedValue("https://www.googleapis.com/upload/opaque");
    await initiateSceneFile(actor, "task", token, "S1", "image/jpeg");
    expect(mocks.createResumableUploadSession).toHaveBeenCalledWith("task-S1.jpg", "image/jpeg", "private-folder", {
      sceneTask: "task", sceneFile: "file", sceneLease: createHash("sha256").update(token).digest("hex"),
    });
  });
  it("任意の Drive ファイルの登録を拒否する", async () => {
    mocks.getDriveFileMeta.mockResolvedValue({ id: "drive", size: 10, mimeType: "image/jpeg", appProperties: {}, parents: ["private-folder"] });
    await expect(completeSceneFile(actor, "task", token, "file", "drive")).rejects.toThrow("確認できません");
    expect(mocks.tx.videoSceneFile.update).not.toHaveBeenCalled();
  });
  it("上限件数でも既存スロットは再試行でき、新規スロットは増やせない", async () => {
    mocks.tx.videoSceneTask.findUnique.mockResolvedValue(task());
    mocks.tx.videoSceneFile.findMany.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => ({ id: `f${i}`, slot: `S${i}` })));
    mocks.tx.videoSceneFile.upsert.mockResolvedValue({ id: "f0", filename: "task-S0.jpg" });
    mocks.createResumableUploadSession.mockResolvedValue("https://www.googleapis.com/upload/opaque");
    await expect(initiateSceneFile(actor, "task", token, "S0", "image/jpeg")).resolves.toHaveProperty("fileId", "f0");
    await expect(initiateSceneFile(actor, "task", token, "new", "image/jpeg")).rejects.toThrow("上限");
    expect(mocks.tx.videoSceneFile.upsert).toHaveBeenCalledTimes(1);
  });
});
