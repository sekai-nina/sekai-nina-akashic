"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import {
  FoodCategorySchema,
  FoodNameSchema,
  SaveBlogSchema,
  renameFood,
  retryGivenUpBlog,
  saveReviewedBlog,
  setFoodCategory,
} from "@/lib/domain/discovery-review";
import { formatZodError } from "@/lib/zod-error";

const requireMember = () => requireRole(["admin", "member"]);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** ブログの発見を丸ごと置き換えて確定する (人が確かめた印を付ける) */
export async function saveBlogAction(assetId: string, items: unknown) {
  const user = await requireMember();
  const parsed = SaveBlogSchema.safeParse(items);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    await saveReviewedBlog(user.clearance, assetId, parsed.data);
    revalidatePath("/discoveries");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function setFoodCategoryAction(name: string, category: string) {
  await requireMember();
  const n = FoodNameSchema.safeParse(name);
  const c = FoodCategorySchema.safeParse(category);
  if (!n.success || !c.success) return { ok: false as const, error: "名前か分類が正しくありません" };
  try {
    await setFoodCategory(n.data, c.data);
    revalidatePath("/discoveries");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

/** 名前を変える (全部の発見で書き換え。変更先が既にあれば統合) */
export async function renameFoodAction(from: string, to: string) {
  const user = await requireMember();
  const f = FoodNameSchema.safeParse(from);
  const t = FoodNameSchema.safeParse(to);
  if (!f.success || !t.success) return { ok: false as const, error: "名前が正しくありません" };
  try {
    const changed = await renameFood(user.clearance, f.data, t.data);
    revalidatePath("/discoveries");
    return { ok: true as const, changed };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

/** cron があきらめたブログを、もう一度 cron に試させる */
export async function retryGivenUpAction(assetId: string) {
  const user = await requireMember();
  try {
    await retryGivenUpBlog(user.clearance, assetId);
    revalidatePath("/discoveries");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}
