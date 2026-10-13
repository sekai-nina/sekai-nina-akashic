"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { addShowListRow, ProgressInputError, setShowProgress, type AddListRowResult } from "@/lib/domain/show-progress";
import { SHOWS, type ShowKey } from "@/lib/progress/shows";

const requireMember = () => requireRole(["admin", "member"]);

type Result = { ok: true } | { ok: false; error: string };

const STATUSES = ["done", "excluded"] as const;

/** 番組の回の反映先の状態を決める。`status: null` で取り消す */
export async function setShowProgressAction(
  showKey: ShowKey,
  episode: number,
  target: "list_row" | "articles",
  status: "done" | "excluded" | null,
  note: string
): Promise<Result> {
  const user = await requireMember();
  if (!Object.hasOwn(SHOWS, showKey)) return { ok: false, error: "番組の指定が不正です" };
  // 回番号は 0 以上 (ひななりは #0 から)
  if (!Number.isInteger(episode) || episode < 0) return { ok: false, error: "回の指定が不正です" };
  if (target !== "list_row" && target !== "articles") return { ok: false, error: "反映先の指定が不正です" };
  if (status !== null && !STATUSES.includes(status)) return { ok: false, error: "状態の指定が不正です" };
  try {
    await setShowProgress(user, showKey, episode, target, status, String(note ?? "").slice(0, 200));
    revalidatePath(`/progress/${showKey}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ProgressInputError) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: "失敗しました" };
  }
}

export type AddListRowState =
  | { ok: true; articleShortId: string; articleTitle: string; label: string; push: AddListRowResult["push"] }
  | { ok: false; error: string };

/**
 * 回の動画 1 本ぶんの行を出演一覧に足す (Discord の 📤 と同じことを画面から)。
 * push は公開リポジトリへの書き込みなので admin のみ (`/articles/push` と同じ)。member は行を足すだけ
 */
export async function addShowListRowAction(
  showKey: ShowKey,
  assetId: string,
  cells: Record<string, string>,
  publish: boolean
): Promise<AddListRowState> {
  const user = await requireMember();
  if (!Object.hasOwn(SHOWS, showKey)) return { ok: false, error: "番組の指定が不正です" };
  if (typeof assetId !== "string" || !assetId) return { ok: false, error: "動画の指定が不正です" };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(cells ?? {})) {
    if (typeof k === "string" && typeof v === "string") clean[k.slice(0, 20)] = v.slice(0, 1000);
  }
  try {
    const r = await addShowListRow(user, showKey, assetId, clean, publish && user.role === "admin");
    revalidatePath(`/progress/${showKey}`);
    revalidatePath("/articles", "layout");
    return { ok: true, articleShortId: r.article.shortId, articleTitle: r.article.title, label: r.label, push: r.push };
  } catch (e) {
    if (e instanceof ProgressInputError) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: "失敗しました" };
  }
}
