"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateAssets } from "@/lib/cache";
import { ocrAssetForUser, requestChildrenOcr } from "@/lib/domain/ocr";
import { isOcrConfigured } from "@/lib/ocr/claude";

/** アセット詳細の「OCR」(#379)。OCR 済みなら置き換える (旧本文は版に残る) */
export async function ocrAsset(assetId: string): Promise<{ error?: string; empty?: boolean }> {
  const user = await requireRole(["admin", "member"]);
  if (!isOcrConfigured()) return { error: "ANTHROPIC_API_KEY が未設定です" };
  const res = await ocrAssetForUser(assetId, user);
  if (res.error) return { error: res.error };
  invalidateAssets();
  revalidatePath(`/assets/${assetId}`);
  return { empty: !res.text };
}

/** 子アセット一覧で選んだ画像の OCR (#379)。待ちに入れるだけで、回すのは 15 分ごとの cron */
export async function requestChildrenOcrAction(
  parentId: string,
  assetIds: string[],
): Promise<{ error?: string; count?: number }> {
  const user = await requireRole(["admin", "member"]);
  if (!isOcrConfigured()) return { error: "ANTHROPIC_API_KEY が未設定です" };
  if (!Array.isArray(assetIds) || assetIds.some((id) => typeof id !== "string") || assetIds.length > 500) {
    return { error: "選択が不正です" };
  }
  const count = await requestChildrenOcr(parentId, assetIds, user);
  revalidatePath(`/assets/${parentId}`);
  return { count };
}
