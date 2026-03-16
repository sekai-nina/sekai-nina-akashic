import { SourceKind } from "@prisma/client";
import { prisma } from "@/lib/db";

export interface CreateSourceData {
  sourceKind: SourceKind;
  title?: string;
  url?: string | null;
  publisher?: string | null;
  publishedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateSourceData {
  sourceKind?: SourceKind;
  title?: string;
  url?: string | null;
  publisher?: string | null;
  publishedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export async function addSource(assetId: string, data: CreateSourceData) {
  return prisma.sourceRecord.create({
    data: {
      assetId,
      sourceKind: data.sourceKind,
      title: data.title ?? "",
      url: data.url ?? null,
      publisher: data.publisher ?? null,
      publishedAt: data.publishedAt ?? null,
      metadata: (data.metadata ?? {}) as object,
    },
  });
}

export async function updateSource(id: string, data: UpdateSourceData) {
  return prisma.sourceRecord.update({
    where: { id },
    data: {
      ...(data.sourceKind !== undefined ? { sourceKind: data.sourceKind } : {}),
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.publisher !== undefined ? { publisher: data.publisher } : {}),
      ...(data.publishedAt !== undefined ? { publishedAt: data.publishedAt } : {}),
      ...(data.metadata !== undefined ? { metadata: data.metadata as object } : {}),
    },
  });
}

export async function deleteSource(id: string) {
  return prisma.sourceRecord.delete({
    where: { id },
  });
}
