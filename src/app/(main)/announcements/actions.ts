"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AnnouncementKind } from "@prisma/client";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateAnnouncements } from "@/lib/cache";
import {
  createAnnouncement,
  deleteAnnouncement,
  updateAnnouncement,
  type AnnouncementInput,
} from "@/lib/domain/announcements";

const requireMember = () => requireRole(["admin", "member"]);

/** フォームに返す状態。成功時は redirect するので値は返らない */
export type AnnouncementFormState = { error: string } | null;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * フォーム → 入力。公開日時は <input type="datetime-local"> の JST 表記 ("2026-09-20T12:00") で来る。
 * 「公開する」が外れていれば下書き (publishedAt = null)。チェックありで日時が空なら今
 */
function readInput(formData: FormData): AnnouncementInput {
  const str = (k: string) => ((formData.get(k) as string | null) ?? "").trim();
  const published = formData.get("published") === "on";
  const at = str("publishedAt");
  return {
    title: str("title"),
    body: str("body"),
    kind: (str("kind") || "info") as AnnouncementKind,
    url: str("url") || null,
    publishedAt: published ? (at ? new Date(`${at}:00+09:00`) : new Date()) : null,
  };
}

function revalidate(id?: string) {
  invalidateAnnouncements();
  revalidatePath("/announcements");
  if (id) revalidatePath(`/announcements/${id}`);
}

/** 登録。成功したら詳細へ (描画結果を確認できる)。失敗はフォームに戻して表示する (useActionState) */
export async function createAnnouncementAction(
  _prev: AnnouncementFormState,
  formData: FormData
): Promise<AnnouncementFormState> {
  const user = await requireMember();
  let id: string;
  try {
    const row = await createAnnouncement(readInput(formData), user.id);
    id = row.id;
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidate(id);
  redirect(`/announcements/${id}`);
}

export async function updateAnnouncementAction(
  id: string,
  _prev: AnnouncementFormState,
  formData: FormData
): Promise<AnnouncementFormState> {
  const user = await requireMember();
  try {
    await updateAnnouncement(id, readInput(formData), user.id);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidate(id);
  redirect(`/announcements/${id}`);
}

export async function deleteAnnouncementAction(id: string) {
  const user = await requireMember();
  await deleteAnnouncement(id, user.id);
  revalidate(id);
  redirect("/announcements");
}
