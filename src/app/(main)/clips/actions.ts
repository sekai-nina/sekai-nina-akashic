"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateDossiers } from "@/lib/cache";
import {
  ClipInputError,
  createClip,
  deleteClips,
  moveClips,
  updateClipNote,
  type MoveClipsTarget,
} from "@/lib/domain/clips";
import { toTextType } from "@/lib/utils";

/**
 * クリップ (#41) の Server Actions。
 *
 * 入力起因の失敗 (`ClipInputError`) は throw せず `{ ok: false, error }` で返す —
 * クライアントはフォームの中にそのまま出す。それ以外 (権限・DB) は throw のまま。
 */

export type ClipActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function guard<T extends object>(fn: () => Promise<T>): Promise<ClipActionResult<T>> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (e) {
    if (e instanceof ClipInputError) return { ok: false, error: e.message };
    throw e;
  }
}

function revalidateClips(assetId?: string) {
  invalidateDossiers();
  revalidatePath("/clips");
  revalidatePath("/dossiers");
  if (assetId) revalidatePath(`/assets/${assetId}`);
}

export async function createClipAction(input: {
  assetId: string;
  note?: string;
  excerpt?: string;
  /** クライアント由来なので信用せず、ここで enum に絞り込む */
  excerptType?: string;
  excerptStart?: number;
  excerptEnd?: number;
}): Promise<ClipActionResult<{ id: string; located: boolean }>> {
  const user = await requireRole(["admin", "member"]);
  const result = await guard(async () => {
    const item = await createClip(user, {
      assetId: input.assetId,
      note: input.note,
      excerpt: input.excerpt,
      excerptType: toTextType(input.excerptType),
      excerptStart: Number.isInteger(input.excerptStart) ? input.excerptStart : undefined,
      excerptEnd: Number.isInteger(input.excerptEnd) ? input.excerptEnd : undefined,
    });
    return { id: item.id, located: item.excerptStart != null };
  });
  if (result.ok) revalidateClips(input.assetId);
  return result;
}

export async function moveClipsAction(
  itemIds: string[],
  target: MoveClipsTarget
): Promise<ClipActionResult<{ dossierId: string; moved: number }>> {
  const user = await requireRole(["admin", "member"]);
  const result = await guard(() => moveClips(user, itemIds, target));
  if (result.ok) {
    revalidateClips();
    revalidatePath(`/dossiers/${result.dossierId}`);
  }
  return result;
}

export async function deleteClipsAction(itemIds: string[]): Promise<ClipActionResult<{ count: number }>> {
  const user = await requireRole(["admin", "member"]);
  const result = await guard(async () => ({ count: await deleteClips(user, itemIds) }));
  if (result.ok) revalidateClips();
  return result;
}

export async function updateClipNoteAction(itemId: string, note: string): Promise<ClipActionResult> {
  const user = await requireRole(["admin", "member"]);
  const result = await guard(async () => {
    await updateClipNote(user, itemId, note);
    return {};
  });
  if (result.ok) revalidateClips();
  return result;
}
