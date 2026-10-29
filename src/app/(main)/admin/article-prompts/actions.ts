"use server";

import { revalidatePath } from "next/cache";
import type { ArticleTemplate } from "@prisma/client";
import { requireRole } from "@/lib/auth/require-role";
import { aiTemplates, MAX_RULES_LENGTH, updateArticlePromptRules } from "@/lib/domain/article-prompt-setting";

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
  const rules = ((formData.get("rules") as string) ?? "").slice(0, MAX_RULES_LENGTH);
  await updateArticlePromptRules(template, rules, user.id);
  revalidatePath("/admin/article-prompts");
}

export async function resetArticlePrompt(formData: FormData) {
  const user = await requireRole(["admin"]);
  await updateArticlePromptRules(templateFrom(formData), "", user.id);
  revalidatePath("/admin/article-prompts");
}
