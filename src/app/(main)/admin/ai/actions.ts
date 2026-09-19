"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { setAiEnabled } from "@/lib/domain/ai-setting";

/**
 * 案内AI「ふぃたん」の運転スイッチ。
 *
 * サイトの表示はビルド時に焼き込まれるので、止めたいときに作り直していては間に合わない。
 * ここを切り替えると、Worker が次に見に来た時点（最大1分）で回答を止め、
 * サイトからも入口ごと消える。
 */
export async function toggleAi(formData: FormData) {
  const user = await requireRole(["admin"]);
  const enabled = formData.get("enabled") === "true";
  const note = ((formData.get("note") as string) ?? "").slice(0, 200);

  await setAiEnabled(enabled, note, user.clearance, user.id);
  revalidatePath("/admin/ai");
}
