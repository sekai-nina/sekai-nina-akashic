"use server";

import { revalidatePath } from "next/cache";
import type { MeetGreetFormat } from "@prisma/client";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateDossiers } from "@/lib/cache";
import {
  applyMaterials,
  createMeetGreet,
  deleteMeetGreet,
  getMeetGreet,
  refetchReports,
  updateMeetGreet,
} from "@/lib/domain/meetgreets";
import { applyExcerpts, proposeExcerptsForDossier } from "@/lib/domain/meetgreet-excerpts";
import { importMeetGreets, linkArticles } from "@/lib/domain/meetgreet-import";
import {
  previewMeetGreetArticle,
  restoreMeetGreetExclusions,
  saveMeetGreetArticle,
} from "@/lib/domain/meetgreet-article-save";
import { generateSketch, saveSketchCrops, selectSketch } from "@/lib/domain/meetgreet-sketch";
import {
  ApplyExcerptsSchema,
  SketchCropsSchema,
  ExclusionKeysSchema,
  GenerateSketchSchema,
  MAX_MATERIALS_PER_APPLY,
  UpdateMeetGreetSchema,
} from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";
import type { ApplyExcerptInput } from "@/lib/meetgreet/types";

const requireMember = () => requireRole(["admin", "member"]);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function createMeetGreetAction(input: {
  date: string;
  format: MeetGreetFormat;
  single: string;
  label: string;
  dossierId?: string;
  repoCollectionId?: string;
}) {
  const user = await requireMember();
  try {
    const { id, reused } = await createMeetGreet(user, input);
    invalidateDossiers();
    revalidatePath("/meetgreets");
    revalidatePath("/dossiers");
    revalidatePath("/repo");
    // 同じ回が既にあったときは新しく作らない (#112)。画面でもそう伝える
    return { ok: true as const, id, reused };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function updateMeetGreetAction(
  id: string,
  input: { single?: string; label?: string; extraSketchPrompt?: string }
) {
  const user = await requireMember();
  const parsed = UpdateMeetGreetSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    await updateMeetGreet(user, id, input);
    revalidatePath(`/meetgreets/${id}`);
    revalidatePath("/meetgreets");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function applyMaterialsAction(id: string, assetIds: string[]) {
  const user = await requireMember();
  if (assetIds.length > MAX_MATERIALS_PER_APPLY) {
    return { ok: false as const, error: `一度に反映できるのは ${MAX_MATERIALS_PER_APPLY} 件までです` };
  }
  try {
    const mg = await getMeetGreet(user, id);
    if (!mg) throw new Error("見つかりません");
    const result = await applyMaterials(user, mg, assetIds);
    invalidateDossiers();
    revalidatePath(`/meetgreets/${id}`);
    revalidatePath(`/dossiers/${mg.dossierId}`);
    return { ok: true as const, ...result };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function refetchReportsAction(id: string) {
  const user = await requireMember();
  try {
    const mg = await getMeetGreet(user, id);
    if (!mg) throw new Error("見つかりません");
    const outcome = await refetchReports(user, mg);
    revalidatePath(`/meetgreets/${id}`);
    revalidatePath("/meetgreets");
    if (mg.repoCollectionId) revalidatePath(`/repo/${mg.repoCollectionId}`);
    revalidatePath("/repo");
    return outcome.ok
      ? { ok: true as const, ...outcome.result }
      : { ok: false as const, error: outcome.error };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function deleteMeetGreetAction(id: string) {
  const user = await requireMember();
  try {
    await deleteMeetGreet(user, id);
    revalidatePath("/meetgreets");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

// --- 抜粋の提案 / スケッチ (#108) ---

export async function proposeExcerptsAction(id: string) {
  const user = await requireMember();
  try {
    const mg = await getMeetGreet(user, id);
    if (!mg) throw new Error("見つかりません");
    const blogs = await proposeExcerptsForDossier(user, mg);
    return { ok: true as const, blogs };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function applyExcerptsAction(id: string, inputs: ApplyExcerptInput[]) {
  const user = await requireMember();
  const parsed = ApplyExcerptsSchema.safeParse({ inputs });
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const mg = await getMeetGreet(user, id);
    if (!mg) throw new Error("見つかりません");
    const result = await applyExcerpts(user, mg, parsed.data.inputs);
    invalidateDossiers();
    revalidatePath(`/meetgreets/${id}`);
    revalidatePath(`/dossiers/${mg.dossierId}`);
    return { ok: true as const, ...result };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function generateSketchAction(
  id: string,
  options: { assetIds: string[]; refKeys?: string[]; revisionOf?: string; revisionNote?: string }
) {
  const user = await requireMember();
  const parsed = GenerateSketchSchema.safeParse(options);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const mg = await getMeetGreet(user, id);
    if (!mg) throw new Error("見つかりません");
    const { candidates } = await generateSketch(user, mg, parsed.data);
    revalidatePath(`/meetgreets/${id}`);
    return { ok: true as const, candidates };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

/** 参照写真の切り抜き枠を保存する (#136)。値が null なら枠を外す */
export async function saveSketchCropsAction(
  id: string,
  changes: Record<string, { x: number; y: number; w: number; h: number } | null>
) {
  const user = await requireMember();
  const parsed = SketchCropsSchema.safeParse(changes);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const mg = await getMeetGreet(user, id);
    if (!mg) throw new Error("見つかりません");
    const crops = await saveSketchCrops(user, mg, parsed.data);
    revalidatePath(`/meetgreets/${id}`);
    return { ok: true as const, crops };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function selectSketchAction(id: string, key: string) {
  const user = await requireMember();
  try {
    const mg = await getMeetGreet(user, id);
    if (!mg) throw new Error("見つかりません");
    await selectSketch(user, mg, key);
    revalidatePath(`/meetgreets/${id}`);
    revalidatePath("/meetgreets");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

/** 過去のドシエを取り込む (#118) */
export async function importMeetGreetsAction(dossierIds: string[]) {
  const user = await requireMember();
  if (dossierIds.length === 0 || dossierIds.length > 200) {
    return { ok: false as const, error: "取り込む件数が不正です" };
  }
  try {
    const result = await importMeetGreets(user, dossierIds);
    invalidateDossiers();
    revalidatePath("/meetgreets");
    revalidatePath("/meetgreets/import");
    return { ok: true as const, ...result };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

// --- 記事の生成 (#109) ---

export async function previewArticleAction(id: string, extraExclude: string[] = []) {
  const user = await requireMember();
  const parsed = ExclusionKeysSchema.safeParse(extraExclude);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const keys = parsed.data;
    const mg = await getMeetGreet(user, id);
    if (!mg) throw new Error("見つかりません");
    const preview = await previewMeetGreetArticle(user, { ...mg, format: mg.format }, keys);
    return { ok: true as const, preview };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

/** 「今後足さない」を取り消す (#134) */
export async function restoreExclusionsAction(id: string, keys: string[]) {
  const user = await requireMember();
  const parsed = ExclusionKeysSchema.safeParse(keys);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const mg = await getMeetGreet(user, id);
    if (!mg) throw new Error("見つかりません");
    const restored = await restoreMeetGreetExclusions(user, { ...mg, format: mg.format }, parsed.data);
    revalidatePath(`/meetgreets/${id}`);
    return { ok: true as const, restored };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function saveArticleAction(
  id: string,
  expectedDigest?: string,
  exclude: string[] = []
) {
  const user = await requireMember();
  const parsed = ExclusionKeysSchema.safeParse(exclude);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const keys = parsed.data;
    const mg = await getMeetGreet(user, id);
    if (!mg) throw new Error("見つかりません");
    const result = await saveMeetGreetArticle(
      user,
      { ...mg, format: mg.format },
      expectedDigest,
      keys
    );
    if (!result.ok) return { ok: false as const, error: result.error };
    revalidatePath(`/meetgreets/${id}`);
    revalidatePath("/meetgreets");
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

/** 過去の記事を MeetGreet に紐づける (#109) */
export async function linkArticlesAction(meetGreetIds: string[]) {
  const user = await requireMember();
  if (meetGreetIds.length === 0 || meetGreetIds.length > 200) {
    return { ok: false as const, error: "件数が不正です" };
  }
  try {
    const result = await linkArticles(user, meetGreetIds);
    revalidatePath("/meetgreets");
    revalidatePath("/meetgreets/import");
    return { ok: true as const, ...result };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}
