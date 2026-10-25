"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateAssets } from "@/lib/cache";
import { NinaAuthorConflictError, setNinaAppearance } from "@/lib/domain/nina-appearance";
import { isNinaAppearance, type NinaAppearance } from "@/lib/nina";

/** アセット詳細の「坂井新奈の出演」を切り替える (#261) */
export async function setAssetNinaAppearance(
  assetId: string,
  status: NinaAppearance
): Promise<{ error?: string }> {
  const user = await requireRole(["admin", "member"]);
  if (!isNinaAppearance(status)) return { error: "不正な状態です" };
  try {
    const result = await setNinaAppearance(assetId, status, user.id, user.clearance);
    if (!result) return { error: "アセットが見つかりません" };
  } catch (err) {
    if (err instanceof NinaAuthorConflictError) return { error: err.message };
    throw err;
  }
  invalidateAssets();
  revalidatePath(`/assets/${assetId}`);
  return {};
}
