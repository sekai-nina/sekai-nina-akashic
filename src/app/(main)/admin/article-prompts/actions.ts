"use server";

import { revalidatePath } from "next/cache";
import type { ArticleTemplate } from "@prisma/client";
import { requireRole } from "@/lib/auth/require-role";
import { aiTemplates, updateArticlePromptRules } from "@/lib/domain/article-prompt-setting";

function templateFrom(formData: FormData): ArticleTemplate {
  const key = (formData.get("template") as string) ?? "";
  const def = aiTemplates().find((t) => t.key === key);
  if (!def) throw new Error("AI を使わないテンプレートです");
  return def.key;
}

/** ルール文を保存する。空にすると組み込みの既定に戻る (既定を直したときに追随する) */
export async function saveArticlePrompt(formData: FormData) {
  const user = await requireRole(["admin"]);
  const template = templateFrom(formData);
  // 長さは domain が改行を揃えてから見る (ここで切ると見本の途中で黙って切れる)
  const rules = (formData.get("rules") as string) ?? "";
  await updateArticlePromptRules(template, rules, user.id);
  revalidatePath("/admin/article-prompts");
}

export async function resetArticlePrompt(formData: FormData) {
  const user = await requireRole(["admin"]);
  await updateArticlePromptRules(templateFrom(formData), "", user.id);
  revalidatePath("/admin/article-prompts");
}
