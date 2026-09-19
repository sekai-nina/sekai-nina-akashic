"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { listConfirmedSketches, updateSketchSetting } from "@/lib/domain/sketch-setting";

/**
 * スケッチのプロンプトを保存する (#136)。
 * 空にすると組み込みの既定に戻る (既定を直したときに追随する)。
 */
export async function saveSketchPrompt(formData: FormData) {
  const user = await requireRole(["admin"]);
  const prompt = ((formData.get("prompt") as string) ?? "").slice(0, 20000);
  await updateSketchSetting({ prompt }, user.id);
  revalidatePath("/admin/sketch");
}

export async function resetSketchPrompt() {
  const user = await requireRole(["admin"]);
  await updateSketchSetting({ prompt: "" }, user.id);
  revalidatePath("/admin/sketch");
}

/** 画風の見本を、確定済みスケッチから選んで差し替える */
export async function pickStyleReference(formData: FormData) {
  const user = await requireRole(["admin"]);
  const key = ((formData.get("key") as string) ?? "").trim();
  if (!key) throw new Error("スケッチを選んでください");

  // **画面から来た key をそのまま信用しない。** R2 の任意のオブジェクトを
  // 見本に仕立てられると、見えないはずの画像を外部 AI に送る口になる
  const allowed = await listConfirmedSketches(user.clearance);
  if (!allowed.some((s) => s.key === key)) {
    throw new Error("そのスケッチは選べません");
  }

  await updateSketchSetting({ styleReferenceKey: key }, user.id);
  revalidatePath("/admin/sketch");
  revalidatePath("/meetgreets");
}

/** 見本を組み込みの既定に戻す */
export async function resetStyleReference() {
  const user = await requireRole(["admin"]);
  await updateSketchSetting({ styleReferenceKey: "" }, user.id);
  revalidatePath("/admin/sketch");
  revalidatePath("/meetgreets");
}
