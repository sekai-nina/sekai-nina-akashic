import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(), asset: { count: vi.fn() }, entity: { findMany: vi.fn() },
    faceDetection: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
    assetEntity: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() }, faceScan: { upsert: vi.fn() },
  };
  return { tx, query: vi.fn(), scans: vi.fn(), withClearance: vi.fn(async (_level, fn) => fn(tx)) };
});
vi.mock("@/lib/db", () => ({ withClearance: mocks.withClearance, prismaInternal: { $queryRaw: mocks.query, faceScan: { findMany: mocks.scans } } }));
vi.mock("@/lib/drive", () => ({ downloadFromDrive: vi.fn(), downloadRangeFromDrive: vi.fn() }));
import { listFaceQueue, writeFaceResults } from "./faces";
import { NINA_ENTITY_ID } from "@/lib/nina";
const nina = NINA_ENTITY_ID;
const face = { bbox: [0, 0, 1, 1] as [number, number, number, number], detScore: .9, embedding: Buffer.alloc(2048), predictedEntityId: nina, similarity: .7, frameSec: 2 };
const input = { modelVersion: "buffalo_l@3:video1", faces: [face] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tx.$queryRaw.mockResolvedValue([{ id: "video", kind: "video", ninaAbsent: false }]);
  mocks.tx.asset.count.mockResolvedValue(1);
  mocks.tx.entity.findMany.mockResolvedValue([{ id: nina }]);
  mocks.tx.faceDetection.findMany.mockResolvedValue([]);
  mocks.tx.assetEntity.findMany.mockResolvedValue([]);
});
describe("動画の結果の保存", () => {
  it("実際のAsset.kindで動画を判別し、frameSecを省いても最高点だけではタグを付けない", async () => {
    const result = await writeFaceResults("internal", "video", { ...input, faces: [{ ...face, frameSec: undefined }] });
    expect(result).toMatchObject({ auto: 0, pending: 1, tagsAdded: [] });
    expect(mocks.withClearance).toHaveBeenCalledWith("internal", expect.any(Function));
  });
  it("裏付けがあればタグを付け、不足なら前の自動タグだけを外す", async () => {
    mocks.tx.faceDetection.findMany.mockResolvedValue([{ id: "old", status: "auto", predictedEntityId: nina, confirmedEntityId: null }]);
    mocks.tx.assetEntity.findMany.mockResolvedValue([{ entityId: nina, roleLabel: "face" }]);
    expect(await writeFaceResults("internal", "video", input)).toMatchObject({ tagsRemoved: [nina], pending: 1 });
    mocks.tx.faceDetection.findMany.mockResolvedValue([]);
    mocks.tx.assetEntity.findMany.mockResolvedValue([]);
    expect(await writeFaceResults("internal", "video", { ...input, faces: [{ ...face, videoEvidence: { version: "nina-temporal-v1", distinctBins: 2, spanSec: .5 } }] })).toMatchObject({ auto: 1, tagsAdded: [nina] });
  });
  it("人が確定した動画の顔は、今回の裏付けが不足しても維持する", async () => {
    mocks.tx.faceDetection.findMany.mockResolvedValue([{ id: "human", status: "confirmed", predictedEntityId: nina, confirmedEntityId: nina, frameSec: 40, x1: 0, y1: 0, x2: 1, y2: 1 }]);
    mocks.tx.assetEntity.findMany.mockResolvedValue([{ entityId: nina, roleLabel: "face" }]);
    expect(await writeFaceResults("internal", "video", input)).toMatchObject({ inherited: 1, tagsRemoved: [] });
    expect(mocks.tx.assetEntity.deleteMany).not.toHaveBeenCalled();
  });
  it("画像には動画の裏付けを要求しない", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{ id: "image", kind: "image", ninaAbsent: false }]);
    expect(await writeFaceResults("internal", "image", input)).toMatchObject({ auto: 1, tagsAdded: [nina] });
  });
});
describe("動画だけを別の版で再走査するqueue", () => {
  it("初回SQLとキャッシュの処理済み除外で画像・動画の版を使い分ける", async () => {
    mocks.query.mockResolvedValue([{ id: "i", kind: "image" }, { id: "v", kind: "video" }]);
    expect((await listFaceQueue("internal", "queue-test-v3", 20, false, "queue-test-video1")).items).toHaveLength(2);
    const sql = mocks.query.mock.calls[0][0];
    expect(sql.text).toContain("CASE WHEN a.kind = 'video'");
    expect(sql.values).toContain("queue-test-v3");
    expect(sql.values).toContain("queue-test-video1");
    mocks.scans.mockResolvedValue([{ assetId: "i", modelVersion: "queue-test-v3" }, { assetId: "v", modelVersion: "queue-test-v3" }]);
    expect((await listFaceQueue("internal", "queue-test-v3", 20, false, "queue-test-video1")).items.map(i => i.id)).toEqual(["v"]);
    mocks.scans.mockResolvedValue([{ assetId: "v", modelVersion: "queue-test-video1" }]);
    expect((await listFaceQueue("internal", "queue-test-v3", 20, false, "queue-test-video1")).items).toEqual([]);
  });
});
