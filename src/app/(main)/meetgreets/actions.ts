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
import { generateSketch, selectSketch } from "@/lib/domain/meetgreet-sketch";
import {
  ApplyExcerptsSchema,
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
}) {
  const user = await requireMember();
  try {
    const { id, fetch } = await createMeetGreet(user, input);
    invalidateDossiers();
    revalidatePath("/meetgreets");
    revalidatePath("/dossiers");
    revalidatePath("/repo");
    return { ok: true as const, id, fetch };
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
  options: { assetIds: string[]; revisionOf?: string; revisionNote?: string }
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
