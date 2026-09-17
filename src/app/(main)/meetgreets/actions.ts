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
import { MAX_MATERIALS_PER_APPLY } from "@/lib/meetgreet/api";

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
