/**
 * 記事テンプレートの AI プロンプトの設定。**テンプレートごとに 1 行**。
 *
 * ルール文 (システムプロンプトの前半: 役割・本文の形・鉄則・出力・見本) がコードに埋め込みで、
 * いまどう書いてあるかを画面から見られず、直すのにデプロイが要った。ここに置いて
 * `/admin/article-prompts` から確認・修正できるようにする。
 *
 * **行が無い / 空のときは組み込みの既定 (`defaultRules`) を使う。** 設定を入れ忘れて生成が止まるより、
 * いまの文面で動き続けるほうが事故が小さい (`SketchSetting` と同じ考え方)。
 */

import type { ArticleTemplate } from "@prisma/client";
import { withClearance } from "@/lib/db";
import { MAX_EXTERNAL_AI_CLEARANCE } from "@/lib/meetgreet/config";
import { selectableTemplates, type ArticleTemplateDef } from "@/lib/article-workflow/templates";

/**
 * **設定は固定のクリアランスで読む。** 行は internal なので、操作している人のクリアランスで読むと
 * public の人には無言で 0 行になり、「既定の文面で生成された」ことに誰も気づけない
 * (`sketch-setting.ts` と同じ)
 */
const SETTING_CLEARANCE = MAX_EXTERNAL_AI_CLEARANCE;

/** ルール文の上限 (見本込みで今の既定は 1 万字未満) */
export const MAX_RULES_LENGTH = 50_000;

export type AiTemplateDef = ArticleTemplateDef & { needsAi: true };

/** AI が本文を書くテンプレート (画面に並べる順) */
export function aiTemplates(): AiTemplateDef[] {
  return selectableTemplates().filter((t): t is AiTemplateDef => t.needsAi);
}

export interface ArticlePromptView {
  template: ArticleTemplate;
  /** 実際に使われるルール文 (未設定なら組み込みの既定) */
  rules: string;
  defaultRules: string;
  isDefault: boolean;
  updatedAt: Date | null;
  updatedByName: string | null;
}

/** 生成に使うルール文。直していなければ null (= テンプレートの既定) */
export async function getArticlePromptRules(template: ArticleTemplate): Promise<string | null> {
  const row = await withClearance(SETTING_CLEARANCE, (tx) =>
    tx.articlePromptSetting.findUnique({ where: { template }, select: { rules: true } })
  );
  return row?.rules.trim() ? row.rules : null;
}

export async function listArticlePrompts(): Promise<ArticlePromptView[]> {
  const rows = await withClearance(SETTING_CLEARANCE, (tx) =>
    tx.articlePromptSetting.findMany({
      select: { template: true, rules: true, updatedAt: true, updatedBy: { select: { name: true } } },
    })
  );
  const byTemplate = new Map(rows.map((r) => [r.template, r]));
  return aiTemplates().map((t) => {
    const row = byTemplate.get(t.key);
    const rules = row?.rules.trim() ? row.rules : t.defaultRules;
    return {
      template: t.key,
      rules,
      defaultRules: t.defaultRules,
      isDefault: rules === t.defaultRules,
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedBy?.name ?? null,
    };
  });
}

/** 空文字・既定と同じ文面なら「未設定」に畳む (既定を直したときに追随するように) */
export async function updateArticlePromptRules(
  template: ArticleTemplate,
  rules: string,
  userId: string
): Promise<void> {
  const def = aiTemplates().find((t) => t.key === template);
  if (!def) throw new Error("AI を使わないテンプレートです");
  if (rules.length > MAX_RULES_LENGTH) throw new Error(`長すぎます (${MAX_RULES_LENGTH} 字まで)`);
  // textarea から来ると改行が CRLF になる。既定との比較とキャッシュの一致のため揃える
  const normalized = rules.replace(/\r\n?/g, "\n");
  const stored = normalized.trim() === "" || normalized === def.defaultRules ? "" : normalized;

  await withClearance(SETTING_CLEARANCE, (tx) =>
    tx.articlePromptSetting.upsert({
      where: { template },
      create: { template, rules: stored, updatedById: userId },
      update: { rules: stored, updatedById: userId },
    })
  );
}
