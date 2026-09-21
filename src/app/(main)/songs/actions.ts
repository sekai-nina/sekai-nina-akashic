"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { mergeSongs, updateSong } from "@/lib/domain/songs";
import { UpdateSongSchema } from "@/lib/songs/api";
import { formatZodError } from "@/lib/zod-error";

const requireMember = () => requireRole(["admin", "member"]);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function revalidate(id: string) {
  revalidatePath("/songs");
  revalidatePath(`/songs/${id}`);
}

export async function updateSongAction(
  id: string,
  input: { title?: string; participation?: "unknown" | "member" | "none"; note?: string }
) {
  const user = await requireMember();
  const parsed = UpdateSongSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: formatZodError(parsed.error) };
  try {
    await updateSong(user, id, parsed.data);
    revalidate(id);
    // 公演の表は曲名を出しているので、ライブの画面も更新する
    revalidatePath("/lives");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

/** `sourceId` を `targetId` に統合する (admin のみ。ドメイン側でも判定する) */
export async function mergeSongsAction(sourceId: string, targetId: string) {
  const user = await requireRole(["admin"]);
  try {
    const result = await mergeSongs(user, sourceId, targetId);
    revalidate(targetId);
    revalidatePath(`/songs/${sourceId}`);
    revalidatePath("/lives");
    return { ok: true as const, ...result };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}
