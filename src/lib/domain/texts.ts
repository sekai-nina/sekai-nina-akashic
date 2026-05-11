import { TextType } from "@prisma/client";
import { withClearance } from "@/lib/db";
import { normalizeText } from "@/lib/utils";

export async function addText(
  assetId: string,
  textType: TextType,
  content: string,
  userId: string | null,
  clearance: string,
  language?: string
) {
  return withClearance(clearance, async (tx) => {
    return tx.assetText.create({
      data: {
        assetId,
        textType,
        content,
        normalizedContent: normalizeText(content),
        language: language ?? null,
        createdById: userId ?? null,
      },
    });
  });
}

export async function updateText(id: string, content: string, clearance: string) {
  return withClearance(clearance, async (tx) => {
    return tx.assetText.update({
      where: { id },
      data: {
        content,
        normalizedContent: normalizeText(content),
      },
    });
  });
}

export async function deleteText(id: string, clearance: string) {
  return withClearance(clearance, async (tx) => {
    return tx.assetText.delete({
      where: { id },
    });
  });
}

export async function getTextsForAsset(assetId: string, clearance: string) {
  return withClearance(clearance, async (tx) => {
    return tx.assetText.findMany({
      where: { assetId },
      orderBy: { createdAt: "asc" },
    });
  });
}
