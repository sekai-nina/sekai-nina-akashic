import {
  AssetKind,
  AssetStatus,
  TrustLevel,
  SourceType,
  StorageProvider,
  TextType,
  EntityType,
  SourceKind,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeText } from "@/lib/utils";
import { logAudit } from "./audit";

export interface CreateAssetData {
  kind: AssetKind;
  title?: string;
  description?: string;
  status?: AssetStatus;
  trustLevel?: TrustLevel;
  canonicalDate?: Date | null;
  originalFilename?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  sha256?: string | null;
  sourceType?: SourceType;
  storageProvider?: StorageProvider;
  storageKey?: string | null;
  storageUrl?: string | null;
  thumbnailUrl?: string | null;
  messageBodyPreview?: string | null;
  discordGuildId?: string | null;
  discordChannelId?: string | null;
  discordMessageId?: string | null;
  discordMessageUrl?: string | null;
  discordAuthorId?: string | null;
  discordAuthorName?: string | null;
  discordPostedAt?: Date | null;
  texts?: Array<{
    textType: TextType;
    content: string;
    language?: string;
  }>;
  entities?: Array<{
    entityId: string;
    roleLabel?: string;
  }>;
  sourceRecords?: Array<{
    sourceKind: SourceKind;
    title?: string;
    url?: string | null;
    publisher?: string | null;
    publishedAt?: Date | null;
    metadata?: Record<string, unknown>;
  }>;
}

export interface UpdateAssetData {
  kind?: AssetKind;
  title?: string;
  description?: string;
  status?: AssetStatus;
  trustLevel?: TrustLevel;
  canonicalDate?: Date | null;
  originalFilename?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  sha256?: string | null;
  sourceType?: SourceType;
  storageProvider?: StorageProvider;
  storageKey?: string | null;
  storageUrl?: string | null;
  thumbnailUrl?: string | null;
  messageBodyPreview?: string | null;
  discordGuildId?: string | null;
  discordChannelId?: string | null;
  discordMessageId?: string | null;
  discordMessageUrl?: string | null;
  discordAuthorId?: string | null;
  discordAuthorName?: string | null;
  discordPostedAt?: Date | null;
}

export interface ListAssetsFilters {
  status?: AssetStatus;
  kind?: AssetKind;
  trustLevel?: TrustLevel;
  sourceType?: SourceType;
  page?: number;
  perPage?: number;
}

export async function createAsset(data: CreateAssetData, userId?: string | null) {
  const { texts, entities, sourceRecords, ...assetFields } = data;

  const asset = await prisma.$transaction(async (tx) => {
    const created = await tx.asset.create({
      data: {
        ...assetFields,
        createdById: userId ?? null,
        updatedById: userId ?? null,
        texts: texts
          ? {
              create: texts.map((t) => ({
                textType: t.textType,
                content: t.content,
                normalizedContent: normalizeText(t.content),
                language: t.language,
                createdById: userId ?? null,
              })),
            }
          : undefined,
        entities: entities
          ? {
              create: entities.map((e) => ({
                entityId: e.entityId,
                roleLabel: e.roleLabel,
              })),
            }
          : undefined,
        sourceRecords: sourceRecords
          ? {
              create: sourceRecords.map((s) => ({
                sourceKind: s.sourceKind,
                title: s.title ?? "",
                url: s.url,
                publisher: s.publisher,
                publishedAt: s.publishedAt,
                metadata: (s.metadata ?? {}) as object,
              })),
            }
          : undefined,
      },
      include: {
        texts: true,
        entities: { include: { entity: true } },
        sourceRecords: true,
        annotations: true,
        collectionItems: true,
      },
    });
    return created;
  });

  await logAudit({
    actorId: userId,
    action: "asset.create",
    targetType: "Asset",
    targetId: asset.id,
    metadata: { kind: asset.kind, title: asset.title },
  });

  return asset;
}

export async function updateAsset(
  id: string,
  data: UpdateAssetData,
  userId?: string | null
) {
  const asset = await prisma.asset.update({
    where: { id },
    data: {
      ...data,
      updatedById: userId ?? null,
    },
  });

  await logAudit({
    actorId: userId,
    action: "asset.update",
    targetType: "Asset",
    targetId: id,
    metadata: { updatedFields: Object.keys(data) },
  });

  return asset;
}

export async function getAsset(id: string) {
  return prisma.asset.findUnique({
    where: { id },
    include: {
      texts: true,
      entities: { include: { entity: true } },
      sourceRecords: true,
      annotations: true,
      collectionItems: true,
    },
  });
}

export async function listAssets(filters: ListAssetsFilters = {}) {
  const { status, kind, trustLevel, sourceType, page = 1, perPage = 20 } = filters;

  const where = {
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(trustLevel ? { trustLevel } : {}),
    ...(sourceType ? { sourceType } : {}),
  };

  const skip = (page - 1) * perPage;

  const [items, total] = await prisma.$transaction([
    prisma.asset.findMany({
      where,
      skip,
      take: perPage,
      orderBy: { createdAt: "desc" },
    }),
    prisma.asset.count({ where }),
  ]);

  return { items, total };
}

export async function checkDuplicateHash(sha256: string) {
  return prisma.asset.findMany({
    where: { sha256 },
  });
}
