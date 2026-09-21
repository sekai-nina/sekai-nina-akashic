"use server";

import { revalidatePath } from "next/cache";
import { ArticleTemplate } from "@prisma/client";
import * as z from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateDossiers } from "@/lib/cache";
import { previewArticle, restoreExclusions, saveArticle } from "@/lib/domain/article-generate";
import { getDossierForArticle, setDossierTemplate } from "@/lib/domain/dossier-article";
import { ExclusionKeysSchema } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

const requireMember = () => requireRole(["admin", "member"]);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const TemplateSchema = z.nativeEnum(ArticleTemplate);

/** テンプレートを決める (#170)。器を持たないドシエだけ */
export async function setTemplateAction(dossierId: string, template: string) {
  const user = await requireMember();
  const parsed = TemplateSchema.safeParse(template);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const dossier = await getDossierForArticle(user, dossierId);
    if (!dossier) throw new Error("ドシエが見つかりません");
    await setDossierTemplate(user, dossier, parsed.data);
    invalidateDossiers();
    revalidatePath(`/dossiers/${dossierId}`);
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
    const dossier = await getDossierForArticle(user, dossierId);
    if (!dossier) throw new Error("ドシエが見つかりません");
    const preview = await previewArticle(user, { kind: "dossier", dossier, articleId }, parsed.data);
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
    const dossier = await getDossierForArticle(user, dossierId);
    if (!dossier) throw new Error("ドシエが見つかりません");
    const restored = await restoreExclusions(user, { kind: "dossier", dossier, articleId }, parsed.data);
    revalidatePath(`/dossiers/${dossierId}/article`);
    return { ok: true as const, restored };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function saveDossierArticleAction(
  dossierId: string,
  articleId: string | null,
  expectedDigest?: string,
  exclude: string[] = []
) {
  const user = await requireMember();
  const parsed = ExclusionKeysSchema.safeParse(exclude);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const dossier = await getDossierForArticle(user, dossierId);
    if (!dossier) throw new Error("ドシエが見つかりません");
    const result = await saveArticle(
      user,
      { kind: "dossier", dossier, articleId },
      expectedDigest,
      parsed.data
    );
    if (!result.ok) return { ok: false as const, error: result.error };
    invalidateDossiers();
    revalidatePath(`/dossiers/${dossierId}`);
    revalidatePath(`/dossiers/${dossierId}/article`);
    revalidatePath("/articles");
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
