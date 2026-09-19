"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { logAudit } from "@/lib/domain/audit";
import { createWatch, deleteWatch, setExcludedUsernames, updateWatch } from "@/lib/domain/x-mentions";
import { runMentionWatch } from "@/lib/x-mentions/run";

export type MentionActionState = { ok: true; message: string } | { ok: false; error: string };

const EDITORS = ["admin", "member"];

function fail(e: unknown): MentionActionState {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

export async function createWatchAction(query: string): Promise<MentionActionState> {
  const user = await requireRole(EDITORS);
  try {
    await createWatch(query, user.clearance);
    revalidatePath("/mentions");
    return { ok: true, message: "監視語を追加しました" };
  } catch (e) {
    return fail(e);
  }
}

export async function updateWatchAction(
  id: string,
  patch: { query?: string; enabled?: boolean }
): Promise<MentionActionState> {
  const user = await requireRole(EDITORS);
  try {
    await updateWatch(id, patch, user.clearance);
    revalidatePath("/mentions");
    return { ok: true, message: "保存しました" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteWatchAction(id: string): Promise<MentionActionState> {
  const user = await requireRole(EDITORS);
  try {
    await deleteWatch(id, user.clearance);
    revalidatePath("/mentions");
    return { ok: true, message: "削除しました" };
  } catch (e) {
    return fail(e);
  }
}

/** 保存した正規化後のユーザー名を返す (フォームの表示を保存後の形に揃えるため) */
export async function setExcludedUsernamesAction(
  input: string
): Promise<MentionActionState | { ok: true; message: string; usernames: string[] }> {
  const user = await requireRole(EDITORS);
  try {
    const saved = await setExcludedUsernames(input, user.clearance, user.id);
    revalidatePath("/mentions");
    return { ok: true, message: `除外ユーザーを ${saved.length} 件保存しました`, usernames: saved };
  } catch (e) {
    return fail(e);
  }
}

/**
 * cron と同じ処理を今すぐ走らせる (X API を叩き、ヒットがあれば Discord にも流れる)。
 * X の読み取り枠を使うので連打しない前提で member 以上に開けている。
 */
export async function runNowAction(): Promise<MentionActionState> {
  const user = await requireRole(EDITORS);
  try {
    const result = await runMentionWatch();
    await logAudit({
      actorId: user.id,
      action: "x_mentions.run",
      targetType: "XMentionWatch",
      targetId: "all",
      metadata: {
        watches: result.watches.length,
        newHits: result.newHits,
        notified: result.notified,
        notifyRemaining: result.notifyRemaining,
        notifyError: result.notifyError,
      },
    });
    revalidatePath("/mentions");
    const failed = result.watches.filter((w) => w.error);
    const parts = [`${result.watches.length} 語を確認、新規 ${result.newHits} 件`];
    if (result.discordConfigured) parts.push(`Discord に ${result.notified} 件通知`);
    if (result.notifyRemaining) parts.push(`残り ${result.notifyRemaining} 件は次回`);
    if (failed.length) return { ok: false, error: `${parts.join("、")}。失敗: ${failed.map((w) => `${w.query} (${w.error})`).join(" / ")}` };
    if (result.notifyError) return { ok: false, error: `${parts.join("、")}。通知に失敗: ${result.notifyError}` };
    return { ok: true, message: parts.join("、") };
  } catch (e) {
    return fail(e);
  }
}
