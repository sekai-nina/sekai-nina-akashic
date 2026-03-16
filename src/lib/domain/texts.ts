import { TextType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeText } from "@/lib/utils";

export async function addText(
  assetId: string,
  textType: TextType,
  content: string,
  userId?: string | null,
  language?: string
) {
  return prisma.assetText.create({
    data: {
      assetId,
      textType,
      content,
      normalizedContent: normalizeText(content),
      language: language ?? null,
      createdById: userId ?? null,
    },
  });
}

export async function updateText(id: string, content: string) {
  return prisma.assetText.update({
    where: { id },
    data: {
      content,
      normalizedContent: normalizeText(content),
    },
  });
}

export async function deleteText(id: string) {
  return prisma.assetText.delete({
    where: { id },
  });
}

export async function getTextsForAsset(assetId: string) {
  return prisma.assetText.findMany({
    where: { assetId },
    orderBy: { createdAt: "asc" },
  });
}
