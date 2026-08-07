import { EntityType, Prisma, type ClearanceLevel } from "@prisma/client";
import { prisma, withClearance } from "@/lib/db";
import { accessibleClassifications } from "@/lib/classification";
import { normalizeText } from "@/lib/utils";
import { logAudit } from "./audit";

/**
 * クリアランスで参照できない place エンティティを除くための WHERE 断片。
 *
 * Entity テーブルには実質的な RLS が無い (`entity_app_runtime` は `qual: true` の
 * 素通しポリシーで、アクセス許可のためだけに存在する)。そのため `type: "place"` の
 * エンティティは、紐づく Place が上位機密でも名前と説明が誰にでも列挙できてしまう。
 * Place 側の RLS は Place 行そのものしか守らない。
 *
 * Entity は CLI のバックアップを含む複数箇所から素の `prisma` で触られており、
 * DB 側に本物のポリシーを足すと `app.clearance` 未設定の経路が無言で 0 行になる
 * (バックアップから聖地が欠落する) ため、アプリ層で塞ぐ。
 *
 * **必ず `withClearance` の中で使うこと。** 素の `prisma` から使うと Place の RLS で
 * 全 Place が見えず、place エンティティが丸ごと消える (安全側だが実用にならない)。
 *
 * Place を持たない place エンティティ (孤児) も除外される。RLS で隠れている Place と
 * 「Place が無い」は Prisma からは区別できないため、孤児を通すと機密の聖地まで通ってしまう。
 * 孤児が生まれないよう findOrCreateEntity 側で `type: "place"` を拒否している。
 */
export function entityClearanceWhere(clearance: string): Prisma.EntityWhereInput {
  const allowed = accessibleClassifications(clearance as ClearanceLevel);
  return {
    OR: [
      { type: { not: "place" } },
      { place: { classification: { in: allowed.length > 0 ? allowed : ["public"] } } },
    ],
  };
}

/**
 * 汎用のエンティティ作成。**`type: "place"` は受け付けない。**
 *
 * 聖地は Entity と Place が 1:1 で対になっている前提で、Place を持たない place
 * エンティティ (孤児) ができると entityClearanceWhere から恒久的に消えてしまう
 * (RLS で隠れている Place と「Place が無い」を区別できないため)。
 * 聖地の作成は createPlace を通すこと。
 */
export async function findOrCreateEntity(type: EntityType, canonicalName: string) {
  if (type === "place") {
    throw new Error(
      "place エンティティは createPlace 経由で作成してください (Place と対で作る必要があります)"
    );
  }
  const normalizedName = normalizeText(canonicalName);

  return prisma.entity.upsert({
    where: {
      type_canonicalName: { type, canonicalName },
    },
    update: {},
    create: {
      type,
      canonicalName,
      normalizedName,
    },
  });
}

export async function searchEntities(
  query: string,
  type?: EntityType,
  take: number = 20,
  clearance: string = "public"
) {
  const normalizedQuery = normalizeText(query);

  // Place の RLS を効かせるため withClearance の中で引く (素の prisma だと
  // entityClearanceWhere が place エンティティを全部落としてしまう)
  return withClearance(clearance, (tx) =>
    tx.entity.findMany({
      where: {
        AND: [
          entityClearanceWhere(clearance),
          {
            ...(type ? { type } : {}),
            normalizedName: {
              contains: normalizedQuery,
              mode: "insensitive",
            },
          },
        ],
      },
      take,
      orderBy: { canonicalName: "asc" },
    })
  );
}

export async function listEntities(
  type?: EntityType,
  page: number = 1,
  perPage: number = 20,
  clearance: string = "public"
) {
  const where: Prisma.EntityWhereInput = {
    AND: [entityClearanceWhere(clearance), type ? { type } : {}],
  };
  const skip = (page - 1) * perPage;

  return withClearance(clearance, async (tx) => {
    const items = await tx.entity.findMany({
      where,
      skip,
      take: perPage,
      orderBy: { canonicalName: "asc" },
    });
    const total = await tx.entity.count({ where });
    return { items, total };
  });
}

/** ID 引き。クリアランスで参照できない place エンティティは null を返す。 */
export async function getEntityById(id: string, clearance: string) {
  return withClearance(clearance, (tx) =>
    tx.entity.findFirst({
      where: { AND: [{ id }, entityClearanceWhere(clearance)] },
      include: { _count: { select: { assets: true } } },
    })
  );
}

export async function addEntityToAsset(
  assetId: string,
  entityId: string,
  clearance: string,
  roleLabel?: string
) {
  const assetEntity = await withClearance(clearance, async (tx) => {
    return tx.assetEntity.upsert({
      where: {
        assetId_entityId: { assetId, entityId },
      },
      update: {
        roleLabel: roleLabel ?? null,
      },
      create: {
        assetId,
        entityId,
        roleLabel: roleLabel ?? null,
      },
    });
  });

  await logAudit({
    action: "entity.addToAsset",
    targetType: "AssetEntity",
    targetId: assetEntity.id,
    metadata: { assetId, entityId, roleLabel },
  });

  return assetEntity;
}

export async function removeEntityFromAsset(assetId: string, entityId: string, clearance: string) {
  return withClearance(clearance, async (tx) => {
    return tx.assetEntity.delete({
      where: {
        assetId_entityId: { assetId, entityId },
      },
    });
  });
}
