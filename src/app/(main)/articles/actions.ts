"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { addAssetToArticle, removeArticleSource } from "@/lib/domain/articles";
import { toTextType } from "@/lib/utils";

async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  return session.user;
}

/** 書き込み系は admin / member のみ (viewer を弾く)。既存の src/lib/actions.ts と同じ */
async function requireRole(roles: string[]) {
  const user = await requireUser();
  if (!roles.includes(user.role)) throw new Error("Forbidden");
  return user;
}

/**
 * アセット (と抜粋) を記事に紐づける。status は pending 固定。
 * 記事本文への反映は別工程 (AI / 人) が行い、そこで applied に遷移させる。
 */
export async function addAssetToArticleAction(
  articleId: string,
  assetId: string,
  options?: {
    label?: string;
    excerpt?: string;
    /** クライアント由来なので信用せず、ここで enum に絞り込む */
    excerptType?: string;
    excerptStart?: number;
    excerptEnd?: number;
  },
) {
  const user = await requireRole(["admin", "member"]);
  const created = await addAssetToArticle(
    {
      articleId,
      assetId,
      label: options?.label,
      excerpt: options?.excerpt,
      excerptType: toTextType(options?.excerptType),
      excerptStart: options?.excerptStart,
      excerptEnd: options?.excerptEnd,
    },
    user.clearance,
  );
  revalidatePath("/articles");
  return created;
}

export async function removeArticleSourceAction(id: string, shortId: string) {
  const user = await requireRole(["admin", "member"]);
  await removeArticleSource(id, user.clearance);
  revalidatePath("/articles");
  revalidatePath(`/articles/${shortId}`);
}
