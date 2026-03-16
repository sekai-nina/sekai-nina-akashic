import { EntityType } from "@prisma/client";
import { prisma } from "@/lib/db";
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
  perPage: number = 20
) {
  const where = type ? { type } : {};
  const skip = (page - 1) * perPage;

  const [items, total] = await prisma.$transaction([
    prisma.entity.findMany({
      where,
      skip,
      take: perPage,
      orderBy: { canonicalName: "asc" },
    }),
    prisma.entity.count({ where }),
  ]);

  return { items, total };
}

export async function addEntityToAsset(
  assetId: string,
  entityId: string,
  roleLabel?: string
) {
  const assetEntity = await prisma.assetEntity.upsert({
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

  await logAudit({
    action: "entity.addToAsset",
    targetType: "AssetEntity",
    targetId: assetEntity.id,
    metadata: { assetId, entityId, roleLabel },
  });

  return assetEntity;
}

export async function removeEntityFromAsset(assetId: string, entityId: string) {
  return prisma.assetEntity.delete({
    where: {
      assetId_entityId: { assetId, entityId },
    },
  });
}
