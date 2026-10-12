"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { ProgressInputError, setShowProgress } from "@/lib/domain/show-progress";
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
