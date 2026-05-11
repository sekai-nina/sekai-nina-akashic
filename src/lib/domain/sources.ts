import { SourceKind } from "@prisma/client";
import { withClearance } from "@/lib/db";

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

export async function addSource(assetId: string, data: CreateSourceData, clearance: string) {
  return withClearance(clearance, async (tx) => {
    return tx.sourceRecord.create({
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
  });
}

export async function updateSource(id: string, data: UpdateSourceData, clearance: string) {
  return withClearance(clearance, async (tx) => {
    return tx.sourceRecord.update({
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
  });
}

export async function deleteSource(id: string, clearance: string) {
  return withClearance(clearance, async (tx) => {
    return tx.sourceRecord.delete({
      where: { id },
    });
  });
}
