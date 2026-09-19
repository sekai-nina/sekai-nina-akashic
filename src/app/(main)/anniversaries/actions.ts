"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ClearanceLevel } from "@prisma/client";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateAnniversaries } from "@/lib/cache";
import {
  createAnniversary,
  deleteAnniversary,
  updateAnniversary,
  type AnniversaryInput,
} from "@/lib/domain/anniversaries";

const requireMember = () => requireRole(["admin", "member"]);

/** フォームに返す状態。成功時は redirect するので値は返らない */
export type AnniversaryFormState = { error: string } | null;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readInput(formData: FormData): AnniversaryInput {
  const str = (k: string) => ((formData.get(k) as string | null) ?? "").trim();
  return {
    date: str("date"),
    title: str("title"),
    description: str("description"),
    assetId: str("assetId") || null,
    sourceUrl: str("sourceUrl") || null,
    articleId: str("articleId") || null,
    classification: (str("classification") as ClearanceLevel) || undefined,
  };
}

function revalidate(id?: string) {
  invalidateAnniversaries();
  revalidatePath("/anniversaries");
  if (id) revalidatePath(`/anniversaries/${id}`);
}

/** 登録。成功したら詳細へ。失敗はフォームに戻して表示する (useActionState) */
export async function createAnniversaryAction(
  _prev: AnniversaryFormState,
  formData: FormData
): Promise<AnniversaryFormState> {
  const user = await requireMember();
  const input = readInput(formData);
  let id: string;
  try {
    const row = await createAnniversary(input, user.clearance, user.id);
    id = row.id;
    if (input.assetId) revalidatePath(`/assets/${input.assetId}`);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidate(id);
  redirect(`/anniversaries/${id}`);
}

export async function updateAnniversaryAction(
  id: string,
  _prev: AnniversaryFormState,
  formData: FormData
): Promise<AnniversaryFormState> {
  const user = await requireMember();
  const input = readInput(formData);
  try {
    await updateAnniversary(id, input, user.clearance, user.id);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidate(id);
  redirect(`/anniversaries/${id}`);
}

export async function deleteAnniversaryAction(id: string) {
  const user = await requireMember();
  await deleteAnniversary(id, user.clearance, user.id);
  revalidate(id);
  redirect("/anniversaries");
}
