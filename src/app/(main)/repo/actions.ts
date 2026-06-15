"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import type { RepoTweetStatus } from "@prisma/client";
import {
  createCollection,
  renameCollection,
  deleteCollection,
  setTweetStatus,
  bulkSetStatus,
  fetchCollection,
  exportCollection,
  type CreateCollectionInput,
} from "@/lib/domain/repo";
import { XApiError } from "@/lib/twitter/x-search";

async function requireMember() {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  if (!["admin", "member"].includes(session.user.role)) throw new Error("Forbidden");
  return session.user;
}

export async function createCollectionAction(input: CreateCollectionInput) {
  const user = await requireMember();
  try {
    const c = await createCollection(input, user.clearance);
    revalidatePath("/repo");
    return { ok: true as const, id: c.id };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function fetchCollectionAction(collectionId: string) {
  const user = await requireMember();
  try {
    const result = await fetchCollection(collectionId, user.clearance);
    revalidatePath(`/repo/${collectionId}`);
    revalidatePath("/repo");
    return { ok: true as const, ...result };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function setTweetStatusAction(tweetId: string, status: RepoTweetStatus) {
  const user = await requireMember();
  await setTweetStatus(tweetId, status, user.clearance);
  // 選別の流れ（キーボード操作）を妨げないため revalidate しない。
  // 一覧の件数バッジは次回 /repo 訪問時に更新される。
}

export async function bulkSetStatusAction(
  collectionId: string,
  from: RepoTweetStatus,
  to: RepoTweetStatus
) {
  const user = await requireMember();
  await bulkSetStatus(collectionId, from, to, user.clearance);
  revalidatePath(`/repo/${collectionId}`);
}

export async function renameCollectionAction(id: string, name: string) {
  const user = await requireMember();
  const trimmed = name.trim();
  if (!trimmed) return { ok: false as const, error: "名前を入力してください" };
  await renameCollection(id, trimmed, user.clearance);
  revalidatePath("/repo");
  revalidatePath(`/repo/${id}`);
  return { ok: true as const, name: trimmed };
}

export async function deleteCollectionAction(id: string) {
  const user = await requireMember();
  await deleteCollection(id, user.clearance);
  revalidatePath("/repo");
}

export async function exportCollectionAction(
  collectionId: string,
  fmt: "links" | "markdown" | "csv"
) {
  const user = await requireMember();
  return exportCollection(collectionId, fmt, "keep", user.clearance);
}

function errorMessage(e: unknown): string {
  if (e instanceof XApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
