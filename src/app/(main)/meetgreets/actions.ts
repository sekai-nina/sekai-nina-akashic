"use server";

import { revalidatePath } from "next/cache";
import type { MeetGreetFormat } from "@prisma/client";
import { auth } from "@/lib/auth";
import { invalidateDossiers } from "@/lib/cache";
import {
  applyMaterials,
  createMeetGreet,
  deleteMeetGreet,
  getMeetGreet,
  refetchReports,
  updateMeetGreet,
} from "@/lib/domain/meetgreets";

async function requireMember() {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  if (!["admin", "member"].includes(session.user.role)) throw new Error("Forbidden");
  return session.user;
}

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
