/**
 * 顔認識 (#384) の DB 操作。推論ワーカー (sekai-nina-omokage) が API 経由で叩く。
 * 判定の規則は `src/lib/faces/policy.ts`、設計は `docs/face-design.md`。
 *
 * FaceDetection / FaceScan は保護テーブル (親 Asset の classification で RLS) なので、
 * すべて withClearance の中で触る。キーの持ち主のクリアランスより上の画像は見えない。
 */
import { withClearance } from "@/lib/db";
import { downloadFromDrive } from "@/lib/drive";
import { decideFace, FACE_ROLE_LABEL, type FaceWriteInput } from "@/lib/faces/policy";
import { NINA_ENTITY_ID } from "@/lib/nina";

export const QUEUE_DEFAULT_LIMIT = 50;
export const QUEUE_MAX_LIMIT = 200;
/** 1 件あたり base64 で約 2.9 KB。Vercel の応答上限 4.5 MB に収まるよう 1000 件で止める (上げるときは計算し直す) */
export const REFERENCES_MAX_LIMIT = 1000;

/**
 * Vercel の関数は応答が 4.5 MB までなので、それより大きい元画像は返さない。
 * ワーカーはサムネイルに落として処理する
 */
export const ORIGINAL_MAX_BYTES = 4_400_000;

/** 元画像を Drive から取る時間の上限。route の maxDuration (30 秒) に収める */
const DRIVE_DOWNLOAD_TIMEOUT_MS = 20_000;

/** 顔認識の対象: Drive に実体がある画像 */
const targetWhere = { kind: "image", storageProvider: "gdrive", storageKey: { not: null } } as const;

/**
 * まだこのモデルで処理していない画像。新しいものから返す。
 * 残りの件数は画像全体 (約 7 万枚) を数えるので、`withCount` のときだけ数える (毎回のポーリングでは数えない)
 */
export async function listFaceQueue(clearance: string, modelVersion: string, limit: number, withCount = false) {
  const where = { ...targetWhere, faceScans: { none: { modelVersion } } };
  return withClearance(clearance, async (tx) => {
    const [items, remaining] = await Promise.all([
      tx.asset.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, mimeType: true, fileSize: true, thumbnailUrl: true, createdAt: true },
      }),
      withCount ? tx.asset.count({ where }) : Promise.resolve(null),
    ]);
    return { items, remaining };
  });
}

export class FaceAssetNotFoundError extends Error {}
export class FaceOriginalTooLargeError extends Error {}
export class FaceInputError extends Error {}

/** 元画像のバイナリ。見えない・対象外なら FaceAssetNotFoundError */
export async function fetchFaceOriginal(clearance: string, assetId: string) {
  const asset = await withClearance(clearance, (tx) =>
    tx.asset.findFirst({ where: { id: assetId, ...targetWhere }, select: { storageKey: true, mimeType: true, fileSize: true } })
  );
  if (!asset?.storageKey) throw new FaceAssetNotFoundError();
  if (asset.fileSize != null && asset.fileSize > ORIGINAL_MAX_BYTES) throw new FaceOriginalTooLargeError();
  // fileSize が無い古いアセットは、落としてみないと大きさが分からない (落としてから 413 にする)
  const body = await downloadFromDrive(asset.storageKey, { timeoutMs: DRIVE_DOWNLOAD_TIMEOUT_MS });
  if (!body) throw new Error("Drive の認証情報がありません");
  if (body.length > ORIGINAL_MAX_BYTES) throw new FaceOriginalTooLargeError();
  return { body, mimeType: asset.mimeType ?? "application/octet-stream" };
}

export type FaceWriteResult = {
  auto: number;
  pending: number;
  /** 付けた face タグのメンバー */
  tagsAdded: string[];
  /** 外した face タグのメンバー */
  tagsRemoved: string[];
};

/**
 * 1 枚の画像の推論結果を書き込む。
 * - 人が見ていない行 (auto / pending) は置き換える。confirmed / rejected は残す
 * - 自動で付ける顔は AssetEntity (roleLabel = face) にする。既に同じメンバーのタグがあれば roleLabel は変えない
 * - 前回自動で付けたメンバーのうち、今回付かなくなったものの face タグを外す。
 *   roleLabel は手入力もできるので、「face」という文字だけで外さない (前回の auto 行にあったメンバーに限る)。
 *   人が確定した顔のメンバーのタグにも触らない
 * - FaceScan を記録して、次の queue に出さない。`error` 付きなら顔とタグには触らず、失敗として記録する
 *
 * モデルは 1 つずつ動かす前提 (docs/face-design.md)。新旧のワーカーが同時に書くと、後から書いた方の結果が残る
 */
export async function writeFaceResults(clearance: string, assetId: string, input: FaceWriteInput): Promise<FaceWriteResult> {
  return withClearance(clearance, async (tx) => {
    // 同じ画像への書き込みが重なっても、タグの付け外しが食い違わないよう Asset の行をロックする。
    // RLS 下なので見えない行は 0 件になる (FOR UPDATE は UPDATE のポリシーも見るが、条件は SELECT と同じクリアランス。
    // 見えない行は 404 にするのが正しいので、prismaInternal に替えない)。対象は queue と同じ (Drive に実体がある画像)
    const locked = await tx.$queryRaw<{ id: string; ninaAbsent: boolean }[]>`
      SELECT id, "ninaAbsent" FROM "Asset"
      WHERE id = ${assetId} AND kind = 'image' AND "storageProvider" = 'gdrive' AND "storageKey" IS NOT NULL
      FOR UPDATE`;
    if (locked.length === 0) throw new FaceAssetNotFoundError();
    const { ninaAbsent } = locked[0];

    const recordScan = (faceCount: number, error: string | null) =>
      tx.faceScan.upsert({
        where: { assetId_modelVersion: { assetId, modelVersion: input.modelVersion } },
        create: { assetId, modelVersion: input.modelVersion, faceCount, error },
        update: { faceCount, error, scannedAt: new Date() },
      });

    if (input.error) {
      await recordScan(0, input.error);
      return { auto: 0, pending: 0, tagsAdded: [], tagsRemoved: [] };
    }

    const predictedIds = [...new Set(input.faces.map((f) => f.predictedEntityId).filter((id): id is string => !!id))];
    if (predictedIds.length > 0) {
      const persons = await tx.entity.findMany({ where: { id: { in: predictedIds }, type: "person" }, select: { id: true } });
      if (persons.length !== predictedIds.length) {
        const known = new Set(persons.map((p) => p.id));
        throw new FaceInputError(`person のエンティティではない: ${predictedIds.filter((id) => !known.has(id)).join(", ")}`);
      }
    }

    // この画像の既存の顔とタグを 1 回ずつで引く
    const [previous, tags] = await Promise.all([
      tx.faceDetection.findMany({
        where: { assetId },
        select: { status: true, predictedEntityId: true, confirmedEntityId: true },
      }),
      tx.assetEntity.findMany({ where: { assetId }, select: { entityId: true, roleLabel: true } }),
    ]);
    const rejectedEntityIds = new Set(
      previous.filter((r) => r.status === "rejected" && r.predictedEntityId).map((r) => r.predictedEntityId as string)
    );
    // 人が確定した顔のメンバーのタグは、推論し直しても外さない
    const keepEntityIds = new Set(
      previous.filter((r) => r.status === "confirmed" || r.status === "rejected").map((r) => r.confirmedEntityId).filter((id): id is string => !!id)
    );
    const previousAutoIds = new Set(
      previous.filter((r) => r.status === "auto" && r.predictedEntityId).map((r) => r.predictedEntityId as string)
    );

    await tx.faceDetection.deleteMany({ where: { assetId, status: { in: ["auto", "pending"] } } });

    const rows = input.faces.map((f) => {
      const [x1, y1, x2, y2] = f.bbox;
      const status = decideFace(f, { ninaEntityId: NINA_ENTITY_ID, ninaAbsent, rejectedEntityIds });
      return {
        assetId,
        modelVersion: input.modelVersion,
        x1,
        y1,
        x2,
        y2,
        detScore: f.detScore,
        embedding: new Uint8Array(f.embedding),
        predictedEntityId: f.predictedEntityId,
        similarity: f.similarity,
        status,
      };
    });
    if (rows.length > 0) await tx.faceDetection.createMany({ data: rows });

    const autoIds = new Set(rows.filter((r) => r.status === "auto").map((r) => r.predictedEntityId as string));

    const faceTagged = new Set(tags.filter((t) => t.roleLabel === FACE_ROLE_LABEL).map((t) => t.entityId));
    const tagsRemoved = [...previousAutoIds].filter((id) => faceTagged.has(id) && !autoIds.has(id) && !keepEntityIds.has(id));
    if (tagsRemoved.length > 0) {
      await tx.assetEntity.deleteMany({ where: { assetId, roleLabel: FACE_ROLE_LABEL, entityId: { in: tagsRemoved } } });
    }

    const linked = new Set(tags.map((t) => t.entityId));
    const tagsAdded = [...autoIds].filter((id) => !linked.has(id));
    if (tagsAdded.length > 0) {
      // 画面のエンティティ追加など、行ロックを取らない経路と重なっても一意制約で落とさない
      await tx.assetEntity.createMany({
        data: tagsAdded.map((entityId) => ({ assetId, entityId, roleLabel: FACE_ROLE_LABEL })),
        skipDuplicates: true,
      });
    }

    await recordScan(rows.length, null);

    return {
      auto: rows.filter((r) => r.status === "auto").length,
      pending: rows.filter((r) => r.status === "pending").length,
      tagsAdded,
      tagsRemoved,
    };
  });
}

/**
 * 参照に足す顔: 人が確定した顔だけ。自動で付けた顔は返さない (間違いが参照に混ざって広がるのを防ぐ)。
 * id の昇順で `after` から続きを返す
 */
export async function listFaceReferences(clearance: string, after: string | undefined, limit: number) {
  const rows = await withClearance(clearance, (tx) =>
    tx.faceDetection.findMany({
      where: { status: { in: ["confirmed", "rejected"] }, confirmedEntityId: { not: null }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" },
      take: limit,
      select: { id: true, assetId: true, confirmedEntityId: true, embedding: true, modelVersion: true, reviewedAt: true },
    })
  );
  return rows.map((r) => ({
    id: r.id,
    assetId: r.assetId,
    entityId: r.confirmedEntityId as string,
    modelVersion: r.modelVersion,
    embedding: Buffer.from(r.embedding).toString("base64"),
    reviewedAt: r.reviewedAt,
  }));
}
