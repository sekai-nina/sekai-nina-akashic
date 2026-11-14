/**
 * 顔認識の確認 (#409)。確認待ち・自動で付いた顔を人が確定・却下する。
 * 判定の規則 (自動で付けるか) は `src/lib/faces/policy.ts`、ワーカーの書き込みは `faces.ts`。設計は `docs/face-design.md`。
 *
 * FaceDetection / AssetEntity / Asset は保護テーブルなので withClearance の中で触る。
 */
import { unstable_cache } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { classificationFilterSql } from "@/lib/classification";
import { prismaInternal, withClearance } from "@/lib/db";
import { FACE_ROLE_LABEL } from "@/lib/faces/policy";
import { NINA_ENTITY_ID } from "@/lib/nina";
import type { FeedCursor } from "@/lib/domain/faces";

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

/**
 * 確認の画面の 1 ページ分。件数は数えない (確認待ち約 3 万顔を RLS 下で数えると 10 秒かかった。
 * 件数はメンバーごとの数 (getCachedReviewCounts) から出す)
 */
export async function listReviewFaces(
  clearance: string,
  mode: ReviewMode,
  entityId: string | null,
  page: number
): Promise<ReviewFace[]> {
  return withClearance(clearance, async (tx) => {
    const where = reviewWhere(mode, entityId);
    const rows = await tx.faceDetection.findMany({
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
      });
    return rows.map((r) => ({
        id: r.id,
        assetId: r.assetId,
        assetTitle: r.asset.title,
        thumbnailUrl: r.asset.thumbnailUrl,
        bbox: [r.x1, r.y1, r.x2, r.y2],
        similarity: r.similarity,
        predictedEntityId: r.predictedEntityId,
      }));
  });
}

export const FACE_REVIEW_CACHE_TAG = "face-review";

/**
 * 推定したメンバーごとの顔の数 (メニュー用)。reviewWhere と同じ条件。
 * RLS 下の groupBy は行ごとに親 Asset の classification を引くので 10 秒かかった。
 * RLS をバイパスして classification を明示で絞る (CLAUDE.md の「重い集計は prismaInternal + classificationFilterSql」)
 */
export async function countReviewFacesByEntity(clearance: string, mode: ReviewMode): Promise<Record<string, number>> {
  const rows = await prismaInternal.$queryRaw<{ id: string; n: number }[]>(Prisma.sql`
    SELECT f."predictedEntityId" AS id, count(*)::int AS n
    FROM "FaceDetection" f JOIN "Asset" a ON a.id = f."assetId"
    WHERE f.status = ${mode}::"FaceStatus" AND f."frameSec" IS NULL AND f."predictedEntityId" IS NOT NULL
      AND a.kind = 'image' AND ${classificationFilterSql(clearance)}
    GROUP BY 1`);
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

/**
 * countReviewFacesByEntity を 5 分キャッシュする。確定・却下したら FACE_REVIEW_CACHE_TAG を
 * stale-while-revalidate で捨てる (次に開いた人は古い数をすぐ見て、裏で数え直される)
 */
export const getCachedReviewCounts = (clearance: string, mode: ReviewMode) =>
  unstable_cache(() => countReviewFacesByEntity(clearance, mode), ["face-review-counts", clearance, mode], {
    revalidate: 300,
    tags: [FACE_REVIEW_CACHE_TAG],
  })();

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

/** 画面 (Server Action) と API (`POST /api/v1/faces/reviews`) で受ける判断の形 */
export const FaceDecisionsInput = z
  .array(
    z.discriminatedUnion("action", [
      z.object({ faceId: z.string().min(1), action: z.literal("confirm") }),
      z.object({ faceId: z.string().min(1), action: z.literal("reject") }),
      z.object({ faceId: z.string().min(1), action: z.literal("nonmember") }),
      z.object({ faceId: z.string().min(1), action: z.literal("other"), entityId: z.string().min(1) }),
    ])
  )
  .min(1)
  .max(REVIEW_MAX_DECISIONS);

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
    // 同じ書き込み (status と正解) の顔をまとめて 1 回で更新する。1 顔ずつ update すると、40 顔で 40 往復して保存が遅かった
    const groups = new Map<string, { status: "confirmed" | "rejected"; confirmedEntityId: string | null; ids: string[] }>();
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

      const gk = `${status}\t${confirmedEntityId ?? ""}`;
      const g = groups.get(gk) ?? { status, confirmedEntityId, ids: [] };
      g.ids.push(f.id);
      groups.set(gk, g);
    }
    for (const g of groups.values()) {
      await tx.faceDetection.updateMany({
        where: { id: { in: g.ids } },
        data: { status: g.status, confirmedEntityId: g.confirmedEntityId, reviewedById: user.id, reviewedAt: now },
      });
    }

    // タグを外す: 同じアセットに、そのメンバーの自動・確定の顔がもう無いときだけ。外すのは face タグだけ。
    // 対象のアセットの顔を 1 回で引いて、残っているかを手元で判定する
    let tagsRemoved = 0;
    const lost = [...lostAuto].filter((k) => !gained.has(k)).map((k) => k.split("\t") as [string, string]);
    if (lost.length > 0) {
      const rest = await tx.faceDetection.findMany({
        where: { assetId: { in: [...new Set(lost.map(([a]) => a))] }, status: { in: ["auto", "confirmed", "rejected"] } },
        select: { assetId: true, status: true, predictedEntityId: true, confirmedEntityId: true },
      });
      const still = new Set(
        rest.flatMap((r) => {
          const e = r.status === "auto" ? r.predictedEntityId : r.confirmedEntityId;
          return e ? [`${r.assetId}\t${e}`] : [];
        })
      );
      const gone = lost.filter(([a, e]) => !still.has(`${a}\t${e}`));
      if (gone.length > 0) {
        const r = await tx.assetEntity.deleteMany({
          where: { roleLabel: FACE_ROLE_LABEL, OR: gone.map(([assetId, entityId]) => ({ assetId, entityId })) },
        });
        tagsRemoved = r.count;
      }
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

export const REVIEW_FEED_DEFAULT_LIMIT = 50;
export const REVIEW_FEED_MAX_LIMIT = 200;

export type ReviewFeedFace = {
  id: string;
  assetId: string;
  status: "auto" | "pending";
  similarity: number | null;
  bbox: [number, number, number, number];
  assetTitle: string;
  createdAt: string;
  mimeType: string | null;
  fileSize: number | null;
  thumbnailUrl: string | null;
  authors: string[];
  url: string | null;
};

/**
 * Discord で 1 顔ずつ確認してもらう顔 (#441)。`createdAfter` 以降に登録された画像の、この人物と推定された顔。登録の古い順。
 * - 確認待ち (pending) はすべて。人の答えでいちばん手本が増える
 * - 自動 (auto) は、その人物が書き手ではない画像だけ (= #395 で転送される顔。本人のトーク・ブログは数が多く、確認しても手本はほぼ増えない)
 * - 動画の顔は出さない (/faces と同じ。コマを切り出せない)
 * 確定・却下すると pending / auto から外れるので、もう出てこない。登録時刻で切るので、モデルの版を上げても古い画像は出ない
 */
export async function listFaceReviewFeed(
  clearance: string,
  entityId: string,
  createdAfter: Date,
  cursor: FeedCursor | null,
  limit: number
): Promise<ReviewFeedFace[]> {
  return withClearance(clearance, async (tx) => {
    const rows = await tx.faceDetection.findMany({
      where: {
        frameSec: null,
        predictedEntityId: entityId,
        asset: { kind: "image", createdAt: { gte: createdAfter } },
        // 続き (#446): 並びは画像の登録時刻・顔の ID。cursor.id は顔の ID
        ...(cursor
          ? {
              AND: [
                {
                  OR: [
                    { asset: { createdAt: { gt: cursor.createdAt } } },
                    { asset: { createdAt: cursor.createdAt }, id: { gt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
        OR: [
          { status: "pending" },
          {
            status: "auto",
            asset: {
              entities: { none: { entityId, roleLabel: "author" } },
              relationsAsTarget: {
                none: { relationType: "parent_child", source: { entities: { some: { entityId, roleLabel: "author" } } } },
              },
            },
          },
        ],
      },
      orderBy: [{ asset: { createdAt: "asc" } }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        assetId: true,
        status: true,
        similarity: true,
        x1: true,
        y1: true,
        x2: true,
        y2: true,
        asset: {
          select: {
            title: true,
            createdAt: true,
            mimeType: true,
            fileSize: true,
            thumbnailUrl: true,
            entities: {
              where: { roleLabel: "author", entity: { type: "person" } },
              select: { entity: { select: { canonicalName: true } } },
            },
            sourceRecords: { where: { url: { not: null } }, select: { url: true }, take: 1 },
            relationsAsTarget: {
              where: { relationType: "parent_child" },
              take: 1,
              select: { source: { select: { sourceRecords: { where: { url: { not: null } }, select: { url: true }, take: 1 } } } },
            },
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      assetId: r.assetId,
      status: r.status as "auto" | "pending",
      similarity: r.similarity,
      bbox: [r.x1, r.y1, r.x2, r.y2],
      assetTitle: r.asset.title,
      createdAt: r.asset.createdAt.toISOString(),
      mimeType: r.asset.mimeType,
      fileSize: r.asset.fileSize,
      thumbnailUrl: r.asset.thumbnailUrl,
      authors: r.asset.entities.map((e) => e.entity.canonicalName),
      url: r.asset.sourceRecords[0]?.url ?? r.asset.relationsAsTarget[0]?.source.sourceRecords[0]?.url ?? null,
    }));
  });
}
