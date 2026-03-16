import { prisma } from "@/lib/db";
import { logAudit } from "./audit";

export async function createCollection(
  name: string,
  description: string,
  ownerId: string
) {
  const collection = await prisma.collection.create({
    data: {
      name,
      description,
      ownerId,
    },
  });

  await logAudit({
    actorId: ownerId,
    action: "collection.create",
    targetType: "Collection",
    targetId: collection.id,
    metadata: { name },
  });

  return collection;
}

export async function updateCollection(
  id: string,
  data: { name?: string; description?: string }
) {
  return prisma.collection.update({
    where: { id },
    data,
  });
}

export async function deleteCollection(id: string) {
  return prisma.collection.delete({
    where: { id },
  });
}

export async function listCollections(ownerId?: string) {
  return prisma.collection.findMany({
    where: ownerId ? { ownerId } : undefined,
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { items: true } },
    },
  });
}

export async function getCollection(id: string) {
  return prisma.collection.findUnique({
    where: { id },
    include: {
      items: {
        include: { asset: true },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
}

export async function addToCollection(
  collectionId: string,
  assetId: string,
  note?: string
) {
  return prisma.collectionItem.upsert({
    where: {
      collectionId_assetId: { collectionId, assetId },
    },
    update: {
      ...(note !== undefined ? { note } : {}),
    },
    create: {
      collectionId,
      assetId,
      note: note ?? "",
    },
  });
}

export async function removeFromCollection(collectionId: string, assetId: string) {
  return prisma.collectionItem.delete({
    where: {
      collectionId_assetId: { collectionId, assetId },
    },
  });
}

export async function updateCollectionItem(
  id: string,
  data: { note?: string; sortOrder?: number }
) {
  return prisma.collectionItem.update({
    where: { id },
    data,
  });
}
