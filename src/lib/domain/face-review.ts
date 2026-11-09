/**
 * 顔認識の確認 (#409)。確認待ち・自動で付いた顔を人が確定・却下する。
 * 判定の規則 (自動で付けるか) は `src/lib/faces/policy.ts`、ワーカーの書き込みは `faces.ts`。設計は `docs/face-design.md`。
 *
 * FaceDetection / AssetEntity / Asset は保護テーブルなので withClearance の中で触る。
 */
import type { Prisma } from "@prisma/client";
import { withClearance } from "@/lib/db";
import { FACE_ROLE_LABEL } from "@/lib/faces/policy";
import { NINA_ENTITY_ID } from "@/lib/nina";

export const REVIEW_PAGE_SIZE = 40;
/** 1 回に確定・却下できる顔の数 (1 ページ分＋余裕) */
export const REVIEW_MAX_DECISIONS = 100;

/** pending = 確認待ち (似ている順) / auto = 自動で付いた顔 (似ていない順。取り消し用) */
export type ReviewMode = "pending" | "auto";

/**
 * 確認の画面に出す顔の条件。動画の顔 (frameSec あり) は、サムネイルが別のコマで切り抜けないので出さない
 */
function reviewWhere(mode: ReviewMode, entityId: string | null): Prisma.FaceDetectionWhereInput {
  return {
    status: mode,
    frameSec: null,
    asset: { kind: "image" },
    ...(entityId ? { predictedEntityId: entityId } : { predictedEntityId: { not: null } }),
  };
}

export type ReviewFace = {
  id: string;
  assetId: string;
  assetTitle: string;
  thumbnailUrl: string | null;
  bbox: [number, number, number, number];
  similarity: number | null;
  predictedEntityId: string | null;
};

/** 確認の画面の 1 ページ分 */
export async function listReviewFaces(
  clearance: string,
  mode: ReviewMode,
  entityId: string | null,
  page: number
): Promise<{ faces: ReviewFace[]; total: number }> {
  return withClearance(clearance, async (tx) => {
    const where = reviewWhere(mode, entityId);
    const [rows, total] = await Promise.all([
      tx.faceDetection.findMany({
        where,
        orderBy: [{ similarity: mode === "pending" ? "desc" : "asc" }, { id: "asc" }],
        skip: (page - 1) * REVIEW_PAGE_SIZE,
        take: REVIEW_PAGE_SIZE,
        select: {
          id: true,
          assetId: true,
          x1: true,
          y1: true,
          x2: true,
          y2: true,
          similarity: true,
          predictedEntityId: true,
          asset: { select: { title: true, thumbnailUrl: true } },
        },
      }),
      tx.faceDetection.count({ where }),
    ]);
    return {
      total,
      faces: rows.map((r) => ({
        id: r.id,
        assetId: r.assetId,
        assetTitle: r.asset.title,
        thumbnailUrl: r.asset.thumbnailUrl,
        bbox: [r.x1, r.y1, r.x2, r.y2],
        similarity: r.similarity,
        predictedEntityId: r.predictedEntityId,
      })),
    };
  });
}

/** 推定したメンバーごとの顔の数 (メニュー用) */
export async function countReviewFacesByEntity(clearance: string, mode: ReviewMode): Promise<Map<string, number>> {
  return withClearance(clearance, async (tx) => {
    const rows = await tx.faceDetection.groupBy({
      by: ["predictedEntityId"],
      where: reviewWhere(mode, null),
      _count: { _all: true },
    });
    return new Map(rows.filter((r) => r.predictedEntityId).map((r) => [r.predictedEntityId as string, r._count._all]));
  });
}

/**
 * 1 顔分の判断。
 * - confirm: 推定どおり
 * - other: 別のメンバー (entityId)
 * - reject: 推定のメンバーではない (誰かは分からない)
 * - nonmember: メンバー以外・顔ではない
 */
export type FaceDecision =
  | { faceId: string; action: "confirm" }
  | { faceId: string; action: "reject" }
  | { faceId: string; action: "other"; entityId: string }
  | { faceId: string; action: "nonmember" };

export class FaceReviewInputError extends Error {}

export type FaceReviewResult = { updated: number; tagsAdded: number; tagsRemoved: number };

/**
 * 顔の確定・却下を保存する (#409)。
 * - 推定どおり → confirmed + confirmedEntityId = 推定
 * - 別のメンバー → rejected (推定は違う) + confirmedEntityId = そのメンバー
 * - 推定のメンバーではない (誰かは分からない) → rejected + confirmedEntityId = null
 * - メンバー以外 → confirmed + confirmedEntityId = null
 *
 * タグ: 正解のメンバーの face タグが無ければ付ける (既に同じメンバーのタグがあれば roleLabel は変えない)。
 * 自動で付いていた顔を却下したら、そのアセットに同じメンバーの自動・確定の顔が他に無いときだけ、face タグを外す
 * (人が付けた author などのタグには触らない)。坂井新奈を確定したら ninaAbsent を外す (人が「出ている」と判断した)。
 * 確定・却下済みの顔を判断し直すこともできる (同じ規則で上書きする)。
 */
export async function reviewFaces(
  user: { id: string; clearance: string },
  decisions: FaceDecision[]
): Promise<FaceReviewResult> {
  if (decisions.length === 0) return { updated: 0, tagsAdded: 0, tagsRemoved: 0 };
  if (decisions.length > REVIEW_MAX_DECISIONS) throw new FaceReviewInputError(`一度に ${REVIEW_MAX_DECISIONS} 顔まで`);
  if (new Set(decisions.map((d) => d.faceId)).size !== decisions.length) throw new FaceReviewInputError("同じ顔が重複している");

  return withClearance(user.clearance, async (tx) => {
    const faces = await tx.faceDetection.findMany({
      where: { id: { in: decisions.map((d) => d.faceId) } },
      select: { id: true, assetId: true, status: true, predictedEntityId: true, confirmedEntityId: true },
    });
    // 見えない顔 (クリアランスより上の画像) は 0 件になる。黙って一部だけ保存しない
    if (faces.length !== decisions.length) throw new FaceReviewInputError("見つからない顔がある");
    const byId = new Map(faces.map((f) => [f.id, f]));

    const otherIds = [...new Set(decisions.flatMap((d) => (d.action === "other" ? [d.entityId] : [])))];
    if (otherIds.length > 0) {
      const persons = await tx.entity.count({ where: { id: { in: otherIds }, type: "person" } });
      if (persons !== otherIds.length) throw new FaceReviewInputError("メンバーではないエンティティが選ばれている");
    }

    const now = new Date();
    // 判断前に、どのメンバーの顔だったか (自動で付いていたもの) を覚えておく (タグを外すかの判定に使う)
    const lostAuto = new Set<string>(); // `${assetId}\t${entityId}`
    const gained = new Set<string>();
    const ninaConfirmedAssets = new Set<string>();
    for (const d of decisions) {
      const f = byId.get(d.faceId)!;
      let status: "confirmed" | "rejected";
      let confirmedEntityId: string | null;
      if (d.action === "confirm") {
        if (!f.predictedEntityId) throw new FaceReviewInputError("推定の無い顔は「推定どおり」にできない");
        status = "confirmed";
        confirmedEntityId = f.predictedEntityId;
      } else if (d.action === "other") {
        status = d.entityId === f.predictedEntityId ? "confirmed" : "rejected";
        confirmedEntityId = d.entityId;
      } else if (d.action === "reject") {
        status = "rejected";
        confirmedEntityId = null;
      } else {
        status = "confirmed";
        confirmedEntityId = null;
      }
      // 前にこの顔で付いていたメンバー (自動の推定か、人の正解) が変わるなら、タグを外す候補にする
      const before = f.status === "auto" ? f.predictedEntityId : f.status === "pending" ? null : f.confirmedEntityId;
      if (before && before !== confirmedEntityId) lostAuto.add(`${f.assetId}\t${before}`);
      if (confirmedEntityId) gained.add(`${f.assetId}\t${confirmedEntityId}`);
      if (confirmedEntityId === NINA_ENTITY_ID) ninaConfirmedAssets.add(f.assetId);

      await tx.faceDetection.update({
        where: { id: f.id },
        data: { status, confirmedEntityId, reviewedById: user.id, reviewedAt: now },
      });
    }

    // タグを外す: 同じアセットに、そのメンバーの自動・確定の顔がもう無いときだけ。外すのは face タグだけ
    let tagsRemoved = 0;
    for (const key of lostAuto) {
      if (gained.has(key)) continue;
      const [assetId, entityId] = key.split("\t");
      const still = await tx.faceDetection.count({
        where: {
          assetId,
          OR: [
            { status: "auto", predictedEntityId: entityId },
            { status: { in: ["confirmed", "rejected"] }, confirmedEntityId: entityId },
          ],
        },
      });
      if (still > 0) continue;
      const r = await tx.assetEntity.deleteMany({ where: { assetId, entityId, roleLabel: FACE_ROLE_LABEL } });
      tagsRemoved += r.count;
    }

    // タグを付ける: 同じメンバーのタグが無いときだけ (author などを face で潰さない)
    const toAdd = [...gained].map((k) => {
      const [assetId, entityId] = k.split("\t");
      return { assetId, entityId, roleLabel: FACE_ROLE_LABEL };
    });
    const added = toAdd.length > 0 ? await tx.assetEntity.createMany({ data: toAdd, skipDuplicates: true }) : { count: 0 };

    if (ninaConfirmedAssets.size > 0) {
      await tx.asset.updateMany({ where: { id: { in: [...ninaConfirmedAssets] }, ninaAbsent: true }, data: { ninaAbsent: false } });
    }

    return { updated: decisions.length, tagsAdded: added.count, tagsRemoved };
  });
}

export type AssetFace = {
  id: string;
  bbox: [number, number, number, number];
  frameSec: number | null;
  status: "auto" | "pending" | "confirmed" | "rejected";
  similarity: number | null;
  predictedEntityId: string | null;
  predictedName: string | null;
  confirmedEntityId: string | null;
  confirmedName: string | null;
};

/** アセット詳細に出す顔 (#409)。左から順 (動画は秒の順) */
export async function listAssetFaces(clearance: string, assetId: string): Promise<AssetFace[]> {
  return withClearance(clearance, async (tx) => {
    const rows = await tx.faceDetection.findMany({
      where: { assetId },
      orderBy: [{ frameSec: "asc" }, { x1: "asc" }],
      select: {
        id: true,
        x1: true,
        y1: true,
        x2: true,
        y2: true,
        frameSec: true,
        status: true,
        similarity: true,
        predictedEntityId: true,
        confirmedEntityId: true,
        predictedEntity: { select: { canonicalName: true } },
        confirmedEntity: { select: { canonicalName: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      bbox: [r.x1, r.y1, r.x2, r.y2],
      frameSec: r.frameSec,
      status: r.status,
      similarity: r.similarity,
      predictedEntityId: r.predictedEntityId,
      predictedName: r.predictedEntity?.canonicalName ?? null,
      confirmedEntityId: r.confirmedEntityId,
      confirmedName: r.confirmedEntity?.canonicalName ?? null,
    }));
  });
}
