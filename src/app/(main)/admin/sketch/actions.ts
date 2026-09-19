"use server";

import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { requireRole } from "@/lib/auth/require-role";
import { isR2Configured, uploadToR2 } from "@/lib/r2";
import {
  DEFAULT_SKETCH_PROMPT,
  listConfirmedSketches,
  updateSketchSetting,
} from "@/lib/domain/sketch-setting";

/** 見本の画像。長辺をこれに収めて png で持つ (基準スケッチは 1 枚しか使わないので軽くする) */
const STYLE_REFERENCE_MAX_EDGE = 1536;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * スケッチのプロンプトを保存する (#136)。
 * 空にすると組み込みの既定に戻る (既定を直したときに追随する)。
 */
export async function saveSketchPrompt(formData: FormData) {
  const user = await requireRole(["admin"]);
  const prompt = ((formData.get("prompt") as string) ?? "").slice(0, 20000);
  await updateSketchSetting({ prompt }, user.clearance, user.id);
  revalidatePath("/admin/sketch");
}

export async function resetSketchPrompt() {
  const user = await requireRole(["admin"]);
  await updateSketchSetting({ prompt: "" }, user.clearance, user.id);
  revalidatePath("/admin/sketch");
}

/**
 * 画風の見本を差し替える (アップロード)。
 *
 * **毎回あたらしい key に置く。** `uploadToR2` は `immutable` で配るので、同じ key に
 * 上書きすると画面にいつまでも古い画像が出る。
 */
export async function uploadStyleReference(formData: FormData) {
  const user = await requireRole(["admin"]);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("画像を選んでください");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("画像が大きすぎます (12MB まで)");
  }
  if (!isR2Configured()) throw new Error("R2 が未設定です");

  let png: Buffer;
  try {
    png = await sharp(Buffer.from(await file.arrayBuffer()))
      .rotate()
      .resize(STYLE_REFERENCE_MAX_EDGE, STYLE_REFERENCE_MAX_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  } catch {
    throw new Error("画像として読めませんでした");
  }

  const key = `meetgreet/style-reference/${Date.now()}.png`;
  await uploadToR2(key, png, "image/png");
  await updateSketchSetting({ styleReferenceKey: key }, user.clearance, user.id);
  revalidatePath("/admin/sketch");
  revalidatePath("/meetgreets");
}

/** 画風の見本を、確定済みスケッチから選んで差し替える */
export async function pickStyleReference(formData: FormData) {
  const user = await requireRole(["admin"]);
  const key = ((formData.get("key") as string) ?? "").trim();
  if (!key) throw new Error("スケッチを選んでください");

  // **画面から来た key をそのまま信用しない。** R2 の任意のオブジェクトを
  // 見本に仕立てられると、見えないはずの画像を外部 AI に送る口になる
  const allowed = await listConfirmedSketches(user.clearance, 200);
  if (!allowed.some((s) => s.key === key)) {
    throw new Error("そのスケッチは選べません");
  }

  await updateSketchSetting({ styleReferenceKey: key }, user.clearance, user.id);
  revalidatePath("/admin/sketch");
  revalidatePath("/meetgreets");
}

/** 見本を組み込みの既定に戻す */
export async function resetStyleReference() {
  const user = await requireRole(["admin"]);
  await updateSketchSetting({ styleReferenceKey: "" }, user.clearance, user.id);
  revalidatePath("/admin/sketch");
  revalidatePath("/meetgreets");
}

/** 画面が「既定に戻す」を出すために使う */
export async function getDefaultPrompt(): Promise<string> {
  await requireRole(["admin"]);
  return DEFAULT_SKETCH_PROMPT;
}
