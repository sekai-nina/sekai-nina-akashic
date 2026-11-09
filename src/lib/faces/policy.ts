/**
 * 顔認識 (#384) の定数と、自動で付けるかどうかの判定。**DB を触らないモジュールに置く**
 * (`src/lib/clips/errors.ts` と同じ理由: テストが `@/lib/db` を巻き込むと DATABASE_URL の無い CI で落ちる)。
 * DB を触る側は `src/lib/domain/faces.ts`。設計は `docs/face-design.md`。
 */
import { z } from "zod";

/** 推論ワーカー (sekai-nina-omokage) のキー。これだけを持たせ、read / write は持たせない */
export const FACE_WORKER_PERMISSION = "face_worker";

/**
 * `face_worker` のキーで送れるハートビートのジョブ名 (`POST /api/v1/jobs/:key/runs`)。
 * 他の bot のジョブ (`bot.*` など) を偽れないよう、omokage のジョブに限る
 */
export const FACE_WORKER_JOB_PREFIX = "omokage.";

export function canFaceWorkerReportJob(key: string): boolean {
  return key.startsWith(FACE_WORKER_JOB_PREFIX);
}

/**
 * これ以上の類似度なら自動で AssetEntity を付ける。#376 の評価で、現役の precision 98〜99%・
 * 坂井新奈 100% だった値。閾値はサーバーが持ち、ワーカーは類似度をそのまま送る
 */
export const FACE_AUTO_THRESHOLD = 0.4;

/** 自動で付けた AssetEntity の roleLabel。人が付けたタグ (author / subject / 出演) と見分ける */
export const FACE_ROLE_LABEL = "face";

/** 特徴量: L2 正規化した float32 × 512 のリトルエンディアン */
export const EMBEDDING_DIM = 512;
export const EMBEDDING_BYTES = EMBEDDING_DIM * 4;

/** 1 枚の画像に書き込める顔の上限 (集合写真でも 100 を超えることはまず無い) */
export const MAX_FACES_PER_ASSET = 100;

/** モデルのバージョン (例: buffalo_l@1)。queue と書き込みで食い違わないよう、空白や記号を許さない */
export const MODEL_VERSION_PATTERN = /^[A-Za-z0-9._@:-]{1,64}$/;

/** 特徴量の L2 ノルムの許容誤差 (float32 の丸めで 1 から少しずれる) */
const EMBEDDING_NORM_TOLERANCE = 0.01;

export type AutoDecision = "auto" | "pending";

/**
 * 推論した顔を自動で付けるか、人の確認に回すか。
 * - 参照が無く推定できなかった・類似度が閾値未満 → pending
 * - 「出ていない」(ninaAbsent) の画像で坂井新奈と判定 → pending (人の確認を優先する)
 * - 同じアセットで人が却下済みのメンバー → pending
 */
export function decideFace(
  face: { predictedEntityId: string | null; similarity: number | null },
  ctx: { ninaEntityId: string; ninaAbsent: boolean; rejectedEntityIds: ReadonlySet<string> },
  threshold = FACE_AUTO_THRESHOLD
): AutoDecision {
  const { predictedEntityId, similarity } = face;
  if (!predictedEntityId || similarity == null || similarity < threshold) return "pending";
  if (predictedEntityId === ctx.ninaEntityId && ctx.ninaAbsent) return "pending";
  if (ctx.rejectedEntityIds.has(predictedEntityId)) return "pending";
  return "auto";
}

/** 人の判断を引き継ぐとみなす、枠の重なり (IoU) の下限 (#386) */
export const FACE_INHERIT_IOU = 0.5;
/** 動画で「同じコマ」とみなす秒の差 */
const SAME_FRAME_SEC = 0.5;

type Box = { x1: number; y1: number; x2: number; y2: number };

/** 2 つの枠の重なり (Intersection over Union)。0〜1 */
export function iou(a: Box, b: Box): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

export type ReviewedFace = Box & {
  id: string;
  status: "confirmed" | "rejected";
  frameSec: number | null;
  predictedEntityId: string | null;
  confirmedEntityId: string | null;
};
export type NewFace = Box & { frameSec: number | null; predictedEntityId: string | null };

/**
 * 推論し直した顔のうち、人がもう見た顔と同じものを探す (#386)。新しい顔の添字 → 人が見た行の id。
 * 引き継いだ顔は確認待ちに出さず、人が見た行の枠・特徴量を新しいモデルの値に差し替える。
 *
 * 同じ顔とみなす条件:
 * - 同じコマ (画像どうし、または動画で秒の差が 0.5 秒以内) で枠の重なりが FACE_INHERIT_IOU 以上 (大きい順に 1 対 1)
 * - 動画で、コマが違っても、人が確定したメンバー (confirmedEntityId) と新しい推定が同じ。
 *   動画はメンバーごとにいちばん似ていた 1 コマだけを書くので、モデルを変えるとコマがずれる
 *
 * ただし、人の答えが新しい推定を覆っていないものは引き継がない (新しい問いとして確認待ちに出す):
 * 却下だけで正解の無い行は、新しい推定が却下したメンバーと同じときだけ引き継ぐ
 */
export function matchReviewedFaces(faces: NewFace[], reviewed: ReviewedFace[]): Map<number, string> {
  const covers = (r: ReviewedFace, f: NewFace) =>
    r.status === "confirmed" || r.confirmedEntityId != null || r.predictedEntityId === f.predictedEntityId;
  const sameFrame = (r: ReviewedFace, f: NewFace) =>
    (r.frameSec == null && f.frameSec == null) ||
    (r.frameSec != null && f.frameSec != null && Math.abs(r.frameSec - f.frameSec) <= SAME_FRAME_SEC);

  const pairs: { i: number; r: ReviewedFace; score: number }[] = [];
  faces.forEach((f, i) => {
    for (const r of reviewed) {
      if (!sameFrame(r, f) || !covers(r, f)) continue;
      const score = iou(r, f);
      if (score >= FACE_INHERIT_IOU) pairs.push({ i, r, score });
    }
  });
  pairs.sort((a, b) => b.score - a.score);

  const matched = new Map<number, string>();
  const used = new Set<string>();
  for (const { i, r } of pairs) {
    if (matched.has(i) || used.has(r.id)) continue;
    matched.set(i, r.id);
    used.add(r.id);
  }
  // 動画: コマがずれても、人が確定したメンバーと同じ推定なら同じ人の顔とみなす
  faces.forEach((f, i) => {
    if (matched.has(i) || f.frameSec == null || !f.predictedEntityId) return;
    const r = reviewed.find(
      (x) => !used.has(x.id) && x.frameSec != null && x.confirmedEntityId === f.predictedEntityId
    );
    if (r) {
      matched.set(i, r.id);
      used.add(r.id);
    }
  });
  return matched;
}

/**
 * base64 の特徴量を Buffer に戻す。長さが合わない・有限でない値 (NaN / Inf) を含む・
 * L2 正規化されていなければ null (壊れた値が参照に混ざると類似度が全部狂う)
 */
export function decodeEmbedding(b64: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== EMBEDDING_BYTES) return null;
  let sq = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const v = buf.readFloatLE(i * 4);
    if (!Number.isFinite(v)) return null;
    sq += v * v;
  }
  return Math.abs(Math.sqrt(sq) - 1) <= EMBEDDING_NORM_TOLERANCE ? buf : null;
}

const unit = z.number().min(0).max(1);

export const FaceInput = z
  .object({
    bbox: z.tuple([unit, unit, unit, unit]).refine(([x1, y1, x2, y2]) => x1 < x2 && y1 < y2, {
      message: "bbox は [x1, y1, x2, y2] で x1 < x2・y1 < y2 にする",
    }),
    detScore: unit,
    // 検証と同時に Buffer へ戻す (書き込み側で decode し直さない)
    embedding: z.string().transform((s, ctx) => {
      const buf = decodeEmbedding(s);
      if (!buf) {
        ctx.addIssue({
          code: "custom",
          message: `embedding は L2 正規化した float32 × ${EMBEDDING_DIM} (${EMBEDDING_BYTES} バイト) の base64 にする`,
        });
        return z.NEVER;
      }
      return buf;
    }),
    predictedEntityId: z.string().min(1).max(64).nullable(),
    similarity: z.number().min(-1).max(1).nullable(),
    /** 動画の何秒目の顔か (#403)。画像は省く */
    frameSec: z.number().min(0).max(24 * 3600).nullable().optional(),
  })
  .strict();

export const FaceWriteBody = z
  .object({
    modelVersion: z.string().regex(MODEL_VERSION_PATTERN, "modelVersion は英数字と . _ @ : - の 64 文字まで"),
    faces: z.array(FaceInput).max(MAX_FACES_PER_ASSET),
    /**
     * 取り直しても直らない失敗 (Drive に無い・大きすぎてサムネイルも無い・画像として読めない) の理由。
     * 付けると faces は空にして、その画像を queue から外す (失敗が queue の先頭に居座らないように)。
     * 一時的な失敗 (Drive の 5xx など) では送らず、次の回に取り直す
     */
    error: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((b) => !b.error || b.faces.length === 0, { message: "error を付けるときは faces を空にする", path: ["faces"] });

export type FaceWriteInput = z.infer<typeof FaceWriteBody>;
