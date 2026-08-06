"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import type { TextType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { addAssetToArticle, removeArticleSource } from "@/lib/domain/articles";

async function requireUser() {
  const session = await auth();
  if (!session?.user) notFound();
  return session.user;
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
    excerptType?: TextType;
    excerptStart?: number;
    excerptEnd?: number;
  },
) {
  const user = await requireUser();
  const created = await addAssetToArticle(
    {
      articleId,
      assetId,
      label: options?.label,
      excerpt: options?.excerpt,
      excerptType: options?.excerptType,
      excerptStart: options?.excerptStart,
      excerptEnd: options?.excerptEnd,
    },
    user.clearance,
  );
  revalidatePath("/articles");
  revalidatePath(`/assets/${assetId}`);
  return created;
}

export async function removeArticleSourceAction(id: string, shortId: string) {
  const user = await requireUser();
  await removeArticleSource(id, user.clearance);
  revalidatePath("/articles");
  revalidatePath(`/articles/${shortId}`);
}
