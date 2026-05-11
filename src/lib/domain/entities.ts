import { EntityType } from "@prisma/client";
import { prisma, withClearance } from "@/lib/db";
import { normalizeText } from "@/lib/utils";
import { logAudit } from "./audit";

export async function findOrCreateEntity(type: EntityType, canonicalName: string) {
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

export async function searchEntities(query: string, type?: EntityType) {
  const normalizedQuery = normalizeText(query);

  return prisma.entity.findMany({
    where: {
      ...(type ? { type } : {}),
      normalizedName: {
        contains: normalizedQuery,
        mode: "insensitive",
      },
    },
    take: 20,
    orderBy: { canonicalName: "asc" },
  });
}

export async function listEntities(
  type?: EntityType,
  page: number = 1,
  perPage: number = 20,
  clearance: string = "public"
) {
  const where = type ? { type } : {};
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
