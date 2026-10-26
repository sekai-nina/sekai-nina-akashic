"use server";

import { invalidateDossiers } from "@/lib/cache";
import { requireDossierArticleWorkflow, type DossierArticleWorkflow } from "@/lib/domain/dossier-article-workflow";
import { revalidatePath } from "next/cache";
import { ArticleTemplate } from "@prisma/client";
import * as z from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { previewArticle, proposeMerge, restoreExclusions, saveArticle, saveMerge } from "@/lib/domain/article-generate";
import { getDossierForArticle, setDossierTemplate } from "@/lib/domain/dossier-article";
import { AiDraftSchema, ExclusionKeysSchema } from "@/lib/meetgreet/api";
import type { AiDraft } from "@/lib/article-workflow/templates";
import { formatZodError } from "@/lib/zod-error";

const requireMember = () => requireRole(["admin", "member"]);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const TemplateSchema = z.enum(ArticleTemplate);

function revalidateWorkflow(workflow: DossierArticleWorkflow, shortId?: string) {
  invalidateDossiers();
  revalidatePath(`/dossiers/${workflow.dossier.id}`);
  revalidatePath(`/dossiers/${workflow.dossier.id}/article`);
  revalidatePath("/articles");
  if (shortId) revalidatePath(`/articles/${shortId}`);
  if (workflow.preparation) {
    revalidatePath(workflow.preparation.href);
    revalidatePath(workflow.preparation.kind === "meetgreet" ? "/meetgreets" : "/lives");
  }
}

/** テンプレートを決める (#170)。器を持たないドシエだけ */
export async function setTemplateAction(dossierId: string, template: string) {
  const user = await requireMember();
  const parsed = TemplateSchema.safeParse(template);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const dossier = await getDossierForArticle(user, dossierId);
    if (!dossier) throw new Error("企画が見つかりません");
    await setDossierTemplate(user, dossier, parsed.data);
    revalidatePath(`/dossiers/${dossierId}/article`);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

/**
 * 差分を見せる。`articleId` は追記先 (ドシエに記事が 2 本以上あるときだけ要る。
 * 画面は `?article=` で選ぶ)
 */
export async function previewDossierArticleAction(
  dossierId: string,
  articleId: string | null,
  extraExclude: string[] = []
) {
  const user = await requireMember();
  const parsed = ExclusionKeysSchema.safeParse(extraExclude);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const workflow = await requireDossierArticleWorkflow(user, dossierId, articleId);
    const preview = await previewArticle(user, workflow.target, parsed.data);
    return { ok: true as const, preview };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

/** 「今後足さない」を取り消す (#134) */
export async function restoreDossierExclusionsAction(
  dossierId: string,
  articleId: string | null,
  keys: string[]
) {
  const user = await requireMember();
  const parsed = ExclusionKeysSchema.safeParse(keys);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const workflow = await requireDossierArticleWorkflow(user, dossierId, articleId);
    const restored = await restoreExclusions(user, workflow.target, parsed.data);
    revalidateWorkflow(workflow, workflow.article?.shortId);
    return { ok: true as const, restored };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function saveDossierArticleAction(
  dossierId: string,
  articleId: string | null,
  expectedDigest?: string,
  exclude: string[] = [],
  /** プレビューが返した AI の下書き (#171)。null は骨組みだけ */
  aiDraft?: AiDraft | null
) {
  const user = await requireMember();
  const parsed = ExclusionKeysSchema.safeParse(exclude);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  const draft = aiDraft === undefined ? undefined : AiDraftSchema.nullable().safeParse(aiDraft);
  if (draft && !draft.success) return { ok: false as const, error: formatZodError(draft.error) };
  try {
    const workflow = await requireDossierArticleWorkflow(user, dossierId, articleId);
    const result = await saveArticle(
      user,
      workflow.target,
      expectedDigest,
      parsed.data,
      draft?.data
    );
    if (!result.ok) return { ok: false as const, error: result.error };
    revalidateWorkflow(workflow, result.shortId);
    return {
      ok: true as const,
      mode: result.mode,
      shortId: result.shortId,
      added: result.added,
      sources: result.sources,
    };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

/**
 * AI に、新しい素材を既存の本文へ組み込んだ案を作らせる (#275)。記事には書かない (費用はかかる)。
 * `manual` は AI を呼ばず、足す前の本文をそのまま返す (人が書く)
 */
export async function proposeMergeAction(dossierId: string, articleId: string | null, manual = false) {
  const user = await requireMember();
  try {
    const workflow = await requireDossierArticleWorkflow(user, dossierId, articleId);
    return await proposeMerge(user, workflow.target, { manual: manual === true });
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

const MergeBodySchema = z.string().min(1).max(200_000);

/** 人が直した組み込みの案を保存する (#275) */
export async function saveMergeAction(dossierId: string, articleId: string | null, digest: string, body: string) {
  const user = await requireMember();
  const parsed = MergeBodySchema.safeParse(body);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const workflow = await requireDossierArticleWorkflow(user, dossierId, articleId);
    const result = await saveMerge(user, workflow.target, digest, parsed.data);
    if (result.ok) revalidateWorkflow(workflow, result.shortId);
    return result;
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}
