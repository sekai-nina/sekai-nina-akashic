/**
 * 顔認識 (#384) の DB 操作。推論ワーカー (sekai-nina-omokage) が API 経由で叩く。
 * 判定の規則は `src/lib/faces/policy.ts`、設計は `docs/face-design.md`。
 *
 * FaceDetection / FaceScan は保護テーブル (親 Asset の classification で RLS) なので、
 * withClearance の中で触る。キーの持ち主のクリアランスより上の画像は見えない。
 * 例外は queue (listFaceQueue) だけで、重いので RLS をバイパスして classification を明示で絞る。
 */
import { Prisma, type ClearanceLevel } from "@prisma/client";
import { accessibleClassifications, classificationFilterSql } from "@/lib/classification";
import { prismaInternal, withClearance } from "@/lib/db";
import { downloadFromDrive, downloadRangeFromDrive } from "@/lib/drive";
import { decideFace, FACE_ROLE_LABEL, matchReviewedFaces, type FaceWriteInput, type ReviewedFace } from "@/lib/faces/policy";
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

/** 動画は、タグがこれのものだけを対象にする (#403)。番組・配信などの長い動画は対象にしない (#394) */
export const FACE_VIDEO_TAG = "トーク";
/** 対象にする動画の大きさの上限。2026-11 時点でトークの動画は最大 65 MB */
export const FACE_VIDEO_MAX_BYTES = 200_000_000;

/** 顔認識の対象: Drive に実体がある画像と、トークの動画 (#403) */
const targetWhere = {
  storageProvider: "gdrive",
  storageKey: { not: null },
  OR: [
    { kind: "image" },
    {
      kind: "video",
      fileSize: { lte: FACE_VIDEO_MAX_BYTES },
      entities: { some: { entity: { type: "tag", canonicalName: FACE_VIDEO_TAG } } },
    },
  ],
} satisfies Prisma.AssetWhereInput;

type QueueItem = {
  id: string;
  kind: "image" | "video";
  mimeType: string | null;
  fileSize: number | null;
  thumbnailUrl: string | null;
  createdAt: Date;
};

/**
 * 推論ワーカーの queue: まだこのモデルで処理していない対象 (targetWhere と同じ条件)。新しい順。
 * 残りの件数は画像全体 (約 7 万枚) を数えるので、`withCount` のときだけ数える (毎回のポーリングでは数えない)
 *
 * **RLS をバイパスして classification を明示で絞る** (CLAUDE.md の「重い集計は prismaInternal + classificationFilterSql」)。
 * RLS 越しの Prisma の問い合わせだと、トークのタグの付いた AssetEntity 約 8 万行すべてと、処理済みの FaceScan
 * 1 行ずつに親 Asset の classification の確認が走り、1 回 1.5〜12 秒かかっていた (#416)。
 * 返すのは見えてよい (classification がキーの持ち主のクリアランス以下の) 画像のメタデータだけ。
 * 条件を変えたら targetWhere も合わせる。
 *
 * **候補をまとめて引いて 5 分使い回す。** 新しい順に処理済みの行を読み飛ばすので、1 回で約 6 万ページ (約 500 MB) を読む。
 * DB の実行は 0.14 秒でも、ワーカーが 30 秒おきに叩く間に他の処理でページがメモリから追い出され、本番では毎回
 * 2.5〜5 秒かかっていた (すぐもう 1 回流すと 0.12 秒)。候補を QUEUE_CANDIDATES 件引いておき、呼ばれるたびに
 * 処理済みになったものだけを主キーで落として返す。重い問い合わせは候補を使い切ったときと 5 分ごとだけになる。
 * 候補はインスタンスのメモリに置く (インスタンスごとに 1 回引く)。5 分の間に消された・上のクリアランスに変えられた
 * 画像はワーカーの元画像の取得で 404 になり、ワーカーの読み飛ばしに入る。新しく入った画像は最長 5 分待つ。
 */
export async function listFaceQueue(clearance: string, modelVersion: string, limit: number, withCount = false) {
  // 知らないクリアランスは RLS と同じく 0 件にする (classificationFilterSql が `IN ()` の構文エラーになるため先に返す)
  if (accessibleClassifications(clearance as ClearanceLevel).length === 0) return { items: [], remaining: withCount ? 0 : null };
  const [items, remaining] = await Promise.all([
    queueItems(clearance, modelVersion, limit),
    withCount
      ? prismaInternal
          .$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM "Asset" a WHERE ${queueWhere(clearance, modelVersion)}`)
          .then((r) => r[0]?.n ?? 0)
      : Promise.resolve(null),
  ]);
  return { items, remaining };
}

/** 1 回に引いておく候補の数。ワーカーの limit (最大 QUEUE_MAX_LIMIT) より多くする */
const QUEUE_CANDIDATES = 500;
const QUEUE_CANDIDATES_TTL_MS = 5 * 60_000;
const queueCandidates = new Map<string, { at: number; items: QueueItem[]; full: boolean }>();

function queueWhere(clearance: string, modelVersion: string) {
  return Prisma.sql`
    a."storageProvider" = 'gdrive' AND a."storageKey" IS NOT NULL
    AND ${classificationFilterSql(clearance)}
    AND (
      a.kind = 'image'
      OR (
        a.kind = 'video' AND a."fileSize" <= ${FACE_VIDEO_MAX_BYTES}
        AND EXISTS (
          SELECT 1 FROM "AssetEntity" ae JOIN "Entity" e ON e.id = ae."entityId"
          WHERE ae."assetId" = a.id AND e.type = 'tag' AND e."canonicalName" = ${FACE_VIDEO_TAG}
        )
      )
    )
    AND NOT EXISTS (SELECT 1 FROM "FaceScan" s WHERE s."assetId" = a.id AND s."modelVersion" = ${modelVersion})`;
}

async function fetchQueueCandidates(clearance: string, modelVersion: string) {
  const items = await prismaInternal.$queryRaw<QueueItem[]>(Prisma.sql`
    SELECT a.id, a.kind::text AS kind, a."mimeType", a."fileSize", a."thumbnailUrl", a."createdAt"
    FROM "Asset" a WHERE ${queueWhere(clearance, modelVersion)}
    ORDER BY a."createdAt" DESC LIMIT ${QUEUE_CANDIDATES}`);
  return { at: Date.now(), items, full: items.length === QUEUE_CANDIDATES };
}

async function queueItems(clearance: string, modelVersion: string, limit: number): Promise<QueueItem[]> {
  const key = `${clearance}\t${modelVersion}`;
  let entry = queueCandidates.get(key);
  let fresh = false;
  if (!entry || Date.now() - entry.at > QUEUE_CANDIDATES_TTL_MS) {
    entry = await fetchQueueCandidates(clearance, modelVersion);
    fresh = true;
  } else if (entry.items.length > 0) {
    // 前に引いた候補から、その後に処理済みになったものを落とす (主キーで引くだけなので軽い)
    const scanned = await prismaInternal.faceScan.findMany({
      where: { modelVersion, assetId: { in: entry.items.map((i) => i.id) } },
      select: { assetId: true },
    });
    const done = new Set(scanned.map((s) => s.assetId));
    entry = { ...entry, items: entry.items.filter((i) => !done.has(i.id)) };
  }
  // 使い切りそうなら引き直す (候補が上限まであった = まだ後ろに残っているかもしれないとき)
  if (!fresh && entry.full && entry.items.length < limit) entry = await fetchQueueCandidates(clearance, modelVersion);
  queueCandidates.set(key, entry);
  return entry.items.slice(0, limit);
}

export class FaceAssetNotFoundError extends Error {}
export class FaceOriginalTooLargeError extends Error {}
export class FaceInputError extends Error {}

export class FaceRangeError extends Error {}

/**
 * 元ファイルのバイナリ。見えない・対象外なら FaceAssetNotFoundError。
 * `range` を渡すとその範囲だけを Drive から取る (#403。Vercel の応答上限を超える動画を小分けに取るため)。
 * 範囲は ORIGINAL_MAX_BYTES まで。`total` はファイル全体の大きさ (分からなければ null)
 */
export async function fetchFaceOriginal(clearance: string, assetId: string, range?: { start: number; end: number | null }) {
  const asset = await withClearance(clearance, (tx) =>
    tx.asset.findFirst({ where: { id: assetId, ...targetWhere }, select: { storageKey: true, mimeType: true, fileSize: true } })
  );
  if (!asset?.storageKey) throw new FaceAssetNotFoundError();
  if (range) {
    const total = asset.fileSize ?? null;
    if (total != null && range.start >= total) throw new FaceRangeError();
    let end = range.end ?? range.start + ORIGINAL_MAX_BYTES - 1;
    if (end - range.start + 1 > ORIGINAL_MAX_BYTES) throw new FaceOriginalTooLargeError();
    if (total != null) end = Math.min(end, total - 1);
    const chunk = await downloadRangeFromDrive(asset.storageKey, range.start, end, { timeoutMs: DRIVE_DOWNLOAD_TIMEOUT_MS });
    if (!chunk) throw new Error("Drive の認証情報がありません");
    return { body: chunk.body, mimeType: asset.mimeType ?? "application/octet-stream", range: { start: range.start, end: range.start + chunk.body.length - 1, total: chunk.total ?? total } };
  }
  if (asset.fileSize != null && asset.fileSize > ORIGINAL_MAX_BYTES) throw new FaceOriginalTooLargeError();
  // fileSize が無い古いアセットは、落としてみないと大きさが分からない (落としてから 413 にする)
  const body = await downloadFromDrive(asset.storageKey, { timeoutMs: DRIVE_DOWNLOAD_TIMEOUT_MS });
  if (!body) throw new Error("Drive の認証情報がありません");
  if (body.length > ORIGINAL_MAX_BYTES) throw new FaceOriginalTooLargeError();
  return { body, mimeType: asset.mimeType ?? "application/octet-stream", range: null };
}

export type FaceWriteResult = {
  auto: number;
  pending: number;
  /** 人がもう見た顔と同じで、人の判断を引き継いだ顔の数 (#386) */
  inherited: number;
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
    // 見えない行は 404 にするのが正しいので、prismaInternal に替えない)。対象は queue と同じ (Drive に実体がある画像とトークの動画。動画の条件はタグを見るので下で確かめる)
    const locked = await tx.$queryRaw<{ id: string; ninaAbsent: boolean }[]>`
      SELECT id, "ninaAbsent" FROM "Asset"
      WHERE id = ${assetId} AND kind IN ('image', 'video') AND "storageProvider" = 'gdrive' AND "storageKey" IS NOT NULL
      FOR UPDATE`;
    if (locked.length === 0) throw new FaceAssetNotFoundError();
    if ((await tx.asset.count({ where: { id: assetId, ...targetWhere } })) === 0) throw new FaceAssetNotFoundError();
    const { ninaAbsent } = locked[0];

    const recordScan = (faceCount: number, error: string | null) =>
      tx.faceScan.upsert({
        where: { assetId_modelVersion: { assetId, modelVersion: input.modelVersion } },
        create: { assetId, modelVersion: input.modelVersion, faceCount, error },
        update: { faceCount, error, scannedAt: new Date() },
      });

    if (input.error) {
      await recordScan(0, input.error);
      return { auto: 0, pending: 0, inherited: 0, tagsAdded: [], tagsRemoved: [] };
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
        select: {
          id: true,
          status: true,
          predictedEntityId: true,
          confirmedEntityId: true,
          x1: true,
          y1: true,
          x2: true,
          y2: true,
          frameSec: true,
        },
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

    // 人がもう見た顔と同じ顔は、確認待ちに出さずに人の判断を引き継ぐ (#386)。
    // 人が見た行の枠・特徴量を新しいモデルの値に差し替える (参照に返す特徴量も新しいモデルのものになる)
    const reviewed: ReviewedFace[] = previous.flatMap((r) =>
      r.status === "confirmed" || r.status === "rejected" ? [{ ...r, status: r.status }] : []
    );
    const inherited = matchReviewedFaces(
      input.faces.map((f) => ({
        x1: f.bbox[0],
        y1: f.bbox[1],
        x2: f.bbox[2],
        y2: f.bbox[3],
        frameSec: f.frameSec ?? null,
        predictedEntityId: f.predictedEntityId,
      })),
      reviewed
    );
    for (const [i, reviewedId] of inherited) {
      const f = input.faces[i];
      const r = reviewed.find((x) => x.id === reviewedId);
      const [x1, y1, x2, y2] = f.bbox;
      await tx.faceDetection.update({
        where: { id: reviewedId },
        data: {
          modelVersion: input.modelVersion,
          x1,
          y1,
          x2,
          y2,
          detScore: f.detScore,
          embedding: new Uint8Array(f.embedding),
          frameSec: f.frameSec ?? null,
          // 却下の行は「この推定は違う」という判断なので、推定を差し替えない (差し替えると別のメンバーを却下したことになる)
          ...(r?.status === "confirmed" ? { predictedEntityId: f.predictedEntityId, similarity: f.similarity } : {}),
        },
      });
    }

    const rows = input.faces.flatMap((f, i) => {
      if (inherited.has(i)) return [];
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
        frameSec: f.frameSec ?? null,
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

    await recordScan(input.faces.length, null);

    return {
      auto: rows.filter((r) => r.status === "auto").length,
      pending: rows.filter((r) => r.status === "pending").length,
      inherited: inherited.size,
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

/** アセット詳細で子アセットの顔をまとめるときの上限 (ブログ 1 記事の画像は多くて数十枚) */
const FACE_SUMMARY_MAX_CHILDREN = 200;

export type FaceAppearance = {
  entityId: string;
  name: string;
  /** 写っている顔の数 */
  faces: number;
  /** 人が確定した顔があるか (無ければすべて自動の推定) */
  confirmed: boolean;
};

/**
 * 1 枚のアセットに顔認識で写っている人物 (#396)。MCP の akashic_get_asset が返す。
 * - 自動 (auto) は推定のメンバー、人が見た顔 (confirmed / rejected) は人が付けた正解で数える。確認待ち (pending) は数だけ返す
 * - ブログ本文・トークなど子アセット (parent_child) を持つアセットは、子の画像に写っている人物もまとめる
 *   (人物ごとに、写っている子アセットの id を返す)
 */
export async function getFaceSummary(clearance: string, assetId: string) {
  return withClearance(clearance, async (tx) => {
    const children = await tx.assetRelation.findMany({
      where: { sourceId: assetId, relationType: "parent_child" },
      select: { targetId: true },
      orderBy: { sortOrder: "asc" },
      take: FACE_SUMMARY_MAX_CHILDREN,
    });
    const ids = [assetId, ...children.map((c) => c.targetId)];
    const rows = await tx.faceDetection.findMany({
      where: { assetId: { in: ids } },
      select: {
        assetId: true,
        status: true,
        predictedEntityId: true,
        confirmedEntityId: true,
        predictedEntity: { select: { canonicalName: true, type: true } },
        confirmedEntity: { select: { canonicalName: true, type: true } },
      },
    });

    const self = new Map<string, FaceAppearance>();
    const inChildren = new Map<string, FaceAppearance & { assetIds: string[] }>();
    let pendingFaces = 0;
    for (const r of rows) {
      if (r.status === "pending") {
        if (r.assetId === assetId) pendingFaces++;
        continue;
      }
      const human = r.status !== "auto";
      const entityId = human ? r.confirmedEntityId : r.predictedEntityId;
      const entity = human ? r.confirmedEntity : r.predictedEntity;
      // confirmed で正解が無い = メンバー以外の人
      if (!entityId || !entity || entity.type !== "person") continue;
      if (r.assetId === assetId) {
        const a = self.get(entityId) ?? { entityId, name: entity.canonicalName, faces: 0, confirmed: false };
        a.faces++;
        a.confirmed ||= human;
        self.set(entityId, a);
      } else {
        const a = inChildren.get(entityId) ?? { entityId, name: entity.canonicalName, faces: 0, confirmed: false, assetIds: [] };
        a.faces++;
        a.confirmed ||= human;
        if (!a.assetIds.includes(r.assetId)) a.assetIds.push(r.assetId);
        inChildren.set(entityId, a);
      }
    }
    const byFaces = <T extends FaceAppearance>(list: Iterable<T>) => [...list].sort((a, b) => b.faces - a.faces);
    return {
      appearing: byFaces(self.values()),
      pendingFaces,
      appearingInChildren: byFaces(inChildren.values()),
    };
  });
}

export const APPEARANCES_DEFAULT_LIMIT = 50;
export const APPEARANCES_MAX_LIMIT = 200;
/** 本文のプレビューの長さ (Discord に流すとき用) */
const APPEARANCE_TEXT_MAX = 500;
const TEXT_TYPES_FOR_PREVIEW = ["message_body", "body"] as const;

/** 顔認識で「この人物が写っている」とみなす顔 (auto の推定と、人が見た顔の正解。pending は入れない) */
function appearingFaceWhere(entityId: string) {
  return {
    OR: [
      { status: "auto" as const, predictedEntityId: entityId },
      { status: { in: ["confirmed" as const, "rejected" as const] }, confirmedEntityId: entityId },
    ],
  };
}

/**
 * 顔認識でこの人物が写っている画像のうち、`createdAfter` 以降に登録されたもの (#395)。登録の古い順。
 * discord bot が「他のメンバーのトーク・ブログに坂井新奈が写っていたら流す」ために数分おきに叩く。
 *
 * - その人物が書き手 (`author`) の画像は除く (本人のトーク・ブログ)。親 (ブログ本文など) の書き手も見る
 * - 顔認識は登録の数分後に付くので、bot は少し前からの範囲を毎回聞き直し、流したかどうかは自分で覚える
 * - 登録時刻で切るので、モデルの版を上げて全画像を処理し直しても古い画像は出てこない
 */
export async function listFaceAppearances(clearance: string, entityId: string, createdAfter: Date, limit: number) {
  return withClearance(clearance, async (tx) => {
    const notAuthor = { entities: { none: { entityId, roleLabel: "author" } } };
    const assets = await tx.asset.findMany({
      where: {
        ...targetWhere,
        createdAt: { gte: createdAfter },
        faceDetections: { some: appearingFaceWhere(entityId) },
        ...notAuthor,
        relationsAsTarget: { none: { relationType: "parent_child", source: { entities: { some: { entityId, roleLabel: "author" } } } } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        title: true,
        createdAt: true,
        mimeType: true,
        fileSize: true,
        thumbnailUrl: true,
        canonicalDate: true,
        entities: {
          where: { entity: { type: { in: ["person", "tag"] } } },
          select: { roleLabel: true, entity: { select: { canonicalName: true, type: true } } },
        },
        sourceRecords: { select: { sourceKind: true, url: true, publishedAt: true, metadata: true } },
        texts: { where: { textType: { in: [...TEXT_TYPES_FOR_PREVIEW] } }, select: { textType: true, content: true } },
        faceDetections: { where: appearingFaceWhere(entityId), select: { similarity: true, status: true } },
        relationsAsTarget: {
          where: { relationType: "parent_child" },
          take: 1,
          select: {
            source: {
              select: {
                id: true,
                title: true,
                sourceRecords: { select: { url: true }, take: 1 },
                texts: { where: { textType: { in: [...TEXT_TYPES_FOR_PREVIEW] } }, select: { textType: true, content: true } },
              },
            },
          },
        },
      },
    });

    const preview = (texts: { textType: string; content: string }[]) => {
      const t = texts.find((x) => x.textType === "message_body") ?? texts.find((x) => x.textType === "body");
      if (!t) return null;
      const cleaned = t.content.replace(/\{\{IMG:[a-zA-Z0-9_-]+\}\}/g, "").trim();
      if (!cleaned) return null;
      return cleaned.length > APPEARANCE_TEXT_MAX ? `${cleaned.slice(0, APPEARANCE_TEXT_MAX)}…` : cleaned;
    };

    return assets.map((a) => {
      const parent = a.relationsAsTarget[0]?.source ?? null;
      return {
        id: a.id,
        title: a.title,
        createdAt: a.createdAt,
        canonicalDate: a.canonicalDate,
        mimeType: a.mimeType,
        fileSize: a.fileSize,
        thumbnailUrl: a.thumbnailUrl,
        authors: a.entities.filter((e) => e.roleLabel === "author" && e.entity.type === "person").map((e) => e.entity.canonicalName),
        tags: a.entities.filter((e) => e.entity.type === "tag").map((e) => e.entity.canonicalName),
        faces: a.faceDetections.length,
        confirmed: a.faceDetections.some((f) => f.status !== "auto"),
        maxSimilarity: Math.max(...a.faceDetections.map((f) => f.similarity ?? 0)),
        text: preview(a.texts),
        sources: a.sourceRecords.map((s) => ({ sourceKind: s.sourceKind, url: s.url, publishedAt: s.publishedAt, metadata: s.metadata })),
        parent: parent
          ? { id: parent.id, title: parent.title, url: parent.sourceRecords[0]?.url ?? null, text: preview(parent.texts) }
          : null,
      };
    });
  });
}
