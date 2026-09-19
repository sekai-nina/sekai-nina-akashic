"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateDossiers, invalidateEntities } from "@/lib/cache";
import {
  applyMaterials,
  createLive,
  deleteLive,
  getLive,
  replaceSetlist,
  updateLive,
  type SetlistInput,
} from "@/lib/domain/lives";
import { CreateLiveSchema, SetlistSchema, UpdateLiveSchema } from "@/lib/live/api";
import { MAX_MATERIALS_PER_APPLY } from "@/lib/meetgreet/api";
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

export async function updateLiveAction(id: string, input: { name?: string; note?: string }) {
  const user = await requireMember();
  const parsed = UpdateLiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    await updateLive(user, id, parsed.data);
    revalidatePath(`/lives/${id}`);
    revalidatePath("/lives");
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
