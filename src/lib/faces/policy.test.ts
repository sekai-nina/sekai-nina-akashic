import { describe, expect, it } from "vitest";
import { canFaceWorkerReportJob, decideFace, decodeEmbedding, EMBEDDING_BYTES, EMBEDDING_DIM, FaceWriteBody } from "./policy";

/** L2 正規化した特徴量 (全要素 1/√512) */
function unitEmbedding(): Buffer {
  const buf = Buffer.alloc(EMBEDDING_BYTES);
  for (let i = 0; i < EMBEDDING_DIM; i++) buf.writeFloatLE(1 / Math.sqrt(EMBEDDING_DIM), i * 4);
  return buf;
}

const NINA = "nina";
const ctx = { ninaEntityId: NINA, ninaAbsent: false, rejectedEntityIds: new Set<string>() };

describe("decideFace", () => {
  it("閾値以上なら自動で付ける", () => {
    expect(decideFace({ predictedEntityId: "a", similarity: 0.4 }, ctx)).toBe("auto");
    expect(decideFace({ predictedEntityId: "a", similarity: 0.72 }, ctx)).toBe("auto");
  });

  it("閾値未満・推定なしは人の確認に回す", () => {
    expect(decideFace({ predictedEntityId: "a", similarity: 0.39 }, ctx)).toBe("pending");
    expect(decideFace({ predictedEntityId: null, similarity: null }, ctx)).toBe("pending");
    expect(decideFace({ predictedEntityId: "a", similarity: null }, ctx)).toBe("pending");
  });

  it("「出ていない」の画像の坂井新奈は付けない", () => {
    const absent = { ...ctx, ninaAbsent: true };
    expect(decideFace({ predictedEntityId: NINA, similarity: 0.9 }, absent)).toBe("pending");
    // 他のメンバーは ninaAbsent に関係なく付ける
    expect(decideFace({ predictedEntityId: "a", similarity: 0.9 }, absent)).toBe("auto");
    // 「出ていない」でなければ坂井新奈も付ける
    expect(decideFace({ predictedEntityId: NINA, similarity: 0.9 }, ctx)).toBe("auto");
  });

  it("同じアセットで却下済みのメンバーは付けない", () => {
    const rejected = { ...ctx, rejectedEntityIds: new Set(["a"]) };
    expect(decideFace({ predictedEntityId: "a", similarity: 0.9 }, rejected)).toBe("pending");
    expect(decideFace({ predictedEntityId: "b", similarity: 0.9 }, rejected)).toBe("auto");
  });
});

describe("decodeEmbedding", () => {
  const ok = unitEmbedding().toString("base64");

  it("L2 正規化した 2,048 バイトの base64 を受け付ける", () => {
    expect(decodeEmbedding(ok)?.length).toBe(EMBEDDING_BYTES);
  });

  it("NaN を含む・正規化されていない特徴量は弾く", () => {
    const nan = unitEmbedding();
    nan.writeFloatLE(Number.NaN, 0);
    expect(decodeEmbedding(nan.toString("base64"))).toBeNull();
    expect(decodeEmbedding(Buffer.alloc(EMBEDDING_BYTES).toString("base64"))).toBeNull(); // 全部 0
  });

  it("長さ違い・base64 でない文字列は弾く", () => {
    expect(decodeEmbedding(Buffer.alloc(EMBEDDING_BYTES - 4).toString("base64"))).toBeNull();
    expect(decodeEmbedding("not base64!")).toBeNull();
    expect(decodeEmbedding("")).toBeNull();
  });
});

describe("FaceWriteBody", () => {
  const face = {
    bbox: [0.1, 0.2, 0.3, 0.4],
    detScore: 0.9,
    embedding: unitEmbedding().toString("base64"),
    predictedEntityId: "a",
    similarity: 0.5,
  };

  it("正しい形を通す", () => {
    expect(FaceWriteBody.safeParse({ modelVersion: "buffalo_l@1", faces: [face] }).success).toBe(true);
    expect(FaceWriteBody.safeParse({ modelVersion: "buffalo_l@1", faces: [] }).success).toBe(true);
  });

  it("動画の何秒目か (frameSec) は 0 以上の数か null (#403)", () => {
    expect(FaceWriteBody.safeParse({ modelVersion: "v", faces: [{ ...face, frameSec: 12.5 }] }).success).toBe(true);
    expect(FaceWriteBody.safeParse({ modelVersion: "v", faces: [{ ...face, frameSec: null }] }).success).toBe(true);
    expect(FaceWriteBody.safeParse({ modelVersion: "v", faces: [{ ...face, frameSec: -1 }] }).success).toBe(false);
  });

  it("枠が逆向き・範囲外なら弾く", () => {
    expect(FaceWriteBody.safeParse({ modelVersion: "v", faces: [{ ...face, bbox: [0.3, 0.2, 0.1, 0.4] }] }).success).toBe(false);
    expect(FaceWriteBody.safeParse({ modelVersion: "v", faces: [{ ...face, bbox: [0.1, 0.2, 1.3, 0.4] }] }).success).toBe(false);
  });

  it("特徴量は Buffer に戻して返す", () => {
    const r = FaceWriteBody.safeParse({ modelVersion: "buffalo_l@1", faces: [face] });
    expect(r.success && Buffer.isBuffer(r.data.faces[0].embedding)).toBe(true);
  });

  it("modelVersion に空白や記号を許さない", () => {
    expect(FaceWriteBody.safeParse({ modelVersion: "buffalo_l@1 ", faces: [] }).success).toBe(false);
    expect(FaceWriteBody.safeParse({ modelVersion: "", faces: [] }).success).toBe(false);
  });

  it("error を付けるなら faces は空", () => {
    expect(FaceWriteBody.safeParse({ modelVersion: "v", faces: [], error: "Drive に無い" }).success).toBe(true);
    expect(FaceWriteBody.safeParse({ modelVersion: "v", faces: [face], error: "Drive に無い" }).success).toBe(false);
  });

  it("知らないキーは弾く", () => {
    expect(FaceWriteBody.safeParse({ modelVersion: "v", faces: [{ ...face, extra: 1 }] }).success).toBe(false);
  });
});

describe("canFaceWorkerReportJob", () => {
  it("omokage のジョブだけ送れる", () => {
    expect(canFaceWorkerReportJob("omokage.worker")).toBe(true);
    expect(canFaceWorkerReportJob("bot.talk_monitor")).toBe(false);
    expect(canFaceWorkerReportJob("omokage")).toBe(false);
  });
});
