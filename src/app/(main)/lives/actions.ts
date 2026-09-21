"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateDossiers, invalidateEntities } from "@/lib/cache";
import {
  applyMaterials,
  createLive,
  deleteLive,
  getLive,
  liveExcerptTarget,
  refetchReports,
  replaceSetlist,
  updateLive,
  type SetlistInput,
} from "@/lib/domain/lives";
import { applyExcerpts, proposeExcerptsForDossier } from "@/lib/domain/excerpts";
import { generateSketch, saveSketchCrops, selectSketch } from "@/lib/domain/live-sketch";
import { CreateLiveSchema, SetlistSchema, UpdateLiveSchema } from "@/lib/live/api";
import {
  ApplyExcerptsSchema,
  GenerateSketchSchema,
  MAX_MATERIALS_PER_APPLY,
  SketchCropsSchema,
} from "@/lib/meetgreet/api";
import type { ApplyExcerptInput } from "@/lib/meetgreet/types";
import { formatZodError } from "@/lib/zod-error";

const requireMember = () => requireRole(["admin", "member"]);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function createLiveAction(input: {
  name: string;
  note: string;
  entityId?: string;
  performances: SetlistInput["performances"];
  commonSongs: string[];
}) {
  const user = await requireMember();
  // Server Action も公開された口なので REST と同じスキーマを通す
  const parsed = CreateLiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const { id } = await createLive(user, parsed.data);
    invalidateDossiers();
    invalidateEntities();
    revalidatePath("/lives");
    revalidatePath("/dossiers");
    revalidatePath("/repo");
    return { ok: true as const, id };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function updateLiveAction(
  id: string,
  input: { name?: string; note?: string; reportTags?: string[]; extraSketchPrompt?: string }
) {
  const user = await requireMember();
  const parsed = UpdateLiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const row = await updateLive(user, id, parsed.data);
    revalidatePath(`/lives/${id}`);
    revalidatePath("/lives");
    // ハッシュタグを変えると収集の条件も変わる
    if (parsed.data.reportTags !== undefined) {
      revalidatePath("/repo");
      if (row.repoCollectionId) revalidatePath(`/repo/${row.repoCollectionId}`);
    }
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function replaceSetlistAction(id: string, input: SetlistInput) {
  const user = await requireMember();
  const parsed = SetlistSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const live = await getLive(user, id);
    if (!live) throw new Error("見つかりません");
    const result = await replaceSetlist(user, live, parsed.data);
    revalidatePath(`/lives/${id}`);
    revalidatePath("/lives");
    return { ok: true as const, ...result };
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
    const live = await getLive(user, id);
    if (!live) throw new Error("見つかりません");
    const result = await applyMaterials(user, live, assetIds);
    invalidateDossiers();
    revalidatePath(`/lives/${id}`);
    revalidatePath(`/dossiers/${live.dossierId}`);
    return { ok: true as const, ...result };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function deleteLiveAction(id: string) {
  const user = await requireMember();
  try {
    await deleteLive(user, id);
    revalidatePath("/lives");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

// --- X レポ / 抜粋 / スケッチ (#150。ミーグリと同じ部品を使う) ---

export async function refetchReportsAction(id: string) {
  const user = await requireMember();
  try {
    const live = await getLive(user, id);
    if (!live) throw new Error("見つかりません");
    const outcome = await refetchReports(user, live);
    revalidatePath(`/lives/${id}`);
    revalidatePath("/lives");
    if (live.repoCollectionId) revalidatePath(`/repo/${live.repoCollectionId}`);
    revalidatePath("/repo");
    return outcome.ok
      ? { ok: true as const, ...outcome.result }
      : { ok: false as const, error: outcome.error };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function proposeExcerptsAction(id: string) {
  const user = await requireMember();
  try {
    const live = await getLive(user, id);
    if (!live) throw new Error("見つかりません");
    const blogs = await proposeExcerptsForDossier(user, liveExcerptTarget(live));
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
    const live = await getLive(user, id);
    if (!live) throw new Error("見つかりません");
    const result = await applyExcerpts(user, liveExcerptTarget(live), parsed.data.inputs);
    invalidateDossiers();
    revalidatePath(`/lives/${id}`);
    revalidatePath(`/dossiers/${live.dossierId}`);
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
    const live = await getLive(user, id);
    if (!live) throw new Error("見つかりません");
    const { candidates } = await generateSketch(user, live, parsed.data);
    revalidatePath(`/lives/${id}`);
    return { ok: true as const, candidates };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function saveSketchCropsAction(
  id: string,
  changes: Record<string, { x: number; y: number; w: number; h: number } | null>
) {
  const user = await requireMember();
  const parsed = SketchCropsSchema.safeParse(changes);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    const live = await getLive(user, id);
    if (!live) throw new Error("見つかりません");
    const crops = await saveSketchCrops(user, live, parsed.data);
    revalidatePath(`/lives/${id}`);
    return { ok: true as const, crops };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

/** スケッチの追加指示だけを保存する (生成の直前に SketchStep が呼ぶ) */
export async function saveExtraSketchPromptAction(id: string, extra: string) {
  return updateLiveAction(id, { extraSketchPrompt: extra });
}

export async function selectSketchAction(id: string, key: string) {
  const user = await requireMember();
  try {
    const live = await getLive(user, id);
    if (!live) throw new Error("見つかりません");
    await selectSketch(user, live, key);
    revalidatePath(`/lives/${id}`);
    revalidatePath("/lives");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}
