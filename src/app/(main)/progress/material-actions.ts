"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { MaterialProgressInputError, MaterialProgressPermissionError, setMaterialClipProgress } from "@/lib/domain/material-clip-progress";
import { isMaterialSourceKey } from "@/lib/clip-progress/material-items";

export async function setMaterialClipProgressAction(
  sourceKey: string, itemKey: string, field: "done" | "included", value: boolean,
): Promise<{ ok: true } | { ok: false; error: string; readOnly?: boolean }> {
  const user = await requireRole(["admin", "member"]);
  if (!isMaterialSourceKey(sourceKey) || typeof itemKey !== "string" || !itemKey || itemKey.length > 4096 ||
    (field !== "done" && field !== "included") || typeof value !== "boolean") {
    return { ok: false, error: "素材の指定が不正です" };
  }
  try {
    await setMaterialClipProgress(user, sourceKey, itemKey, field === "done" ? { done: value } : { included: value });
    revalidatePath("/progress", "layout");
    revalidatePath("/assets/[id]", "page");
    return { ok: true };
  } catch (error) {
    if (error instanceof MaterialProgressPermissionError) return { ok: false, error: error.message, readOnly: true };
    if (error instanceof MaterialProgressInputError) return { ok: false, error: error.message };
    // Prisma の例外は接続情報を含む可能性があるので出力しない。
    return { ok: false, error: "保存に失敗しました。画面を更新してからお試しください" };
  }
}
