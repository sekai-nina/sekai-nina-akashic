import { AnnotationKind } from "@prisma/client";
import { prisma } from "@/lib/db";

export interface CreateAnnotationData {
  kind: AnnotationKind;
  body: string;
  startMs?: number | null;
  endMs?: number | null;
  textStart?: number | null;
  textEnd?: number | null;
  bbox?: Record<string, unknown> | null;
}

export interface UpdateAnnotationData {
  kind?: AnnotationKind;
  body?: string;
  startMs?: number | null;
  endMs?: number | null;
  textStart?: number | null;
  textEnd?: number | null;
  bbox?: Record<string, unknown> | null;
}

export async function addAnnotation(
  assetId: string,
  data: CreateAnnotationData,
  userId: string
) {
  return prisma.annotation.create({
    data: {
      assetId,
      kind: data.kind,
      body: data.body,
      startMs: data.startMs ?? null,
      endMs: data.endMs ?? null,
      textStart: data.textStart ?? null,
      textEnd: data.textEnd ?? null,
      bbox: (data.bbox ?? undefined) as object | undefined,
      createdById: userId,
    },
  });
}

export async function updateAnnotation(id: string, data: UpdateAnnotationData) {
  return prisma.annotation.update({
    where: { id },
    data: {
      ...(data.kind !== undefined ? { kind: data.kind } : {}),
      ...(data.body !== undefined ? { body: data.body } : {}),
      ...(data.startMs !== undefined ? { startMs: data.startMs } : {}),
      ...(data.endMs !== undefined ? { endMs: data.endMs } : {}),
      ...(data.textStart !== undefined ? { textStart: data.textStart } : {}),
      ...(data.textEnd !== undefined ? { textEnd: data.textEnd } : {}),
      ...(data.bbox !== undefined ? { bbox: data.bbox as object } : {}),
    },
  });
}

export async function deleteAnnotation(id: string) {
  return prisma.annotation.delete({
    where: { id },
  });
}
