"use server";

import { revalidatePath } from "next/cache";
import type { InstaWatchTier } from "@prisma/client";
import { requireRole } from "@/lib/auth/require-role";
import { setInstaAccount } from "@/lib/domain/insta-account";
import { createStoryJob, tickStoryJobs } from "@/lib/domain/insta-jobs";
import { DISPATCHER_NOT_CONFIGURED_MESSAGE } from "@/lib/insta/dispatch";
import { InstaJobError } from "@/lib/insta/jobs";
import {
  InstaTargetError,
  addInstaTarget,
  deleteInstaTarget,
  setInstaTargetEnabled,
} from "@/lib/domain/insta-targets";
import { logAudit } from "@/lib/domain/audit";

export type InstaActionState = { ok: true; message: string } | { ok: false; error: string };

export async function addInstaTargetAction(input: {
  handle: string;
  tier: string;
  intervalMinutes: string;
  note: string;
}): Promise<InstaActionState> {
  const user = await requireRole(["admin"]);
  const tier = input.tier as InstaWatchTier;
  if (!["hot", "normal", "cold"].includes(tier)) return { ok: false, error: "頻度が不正です" };

  const minutes = input.intervalMinutes.trim() ? Number(input.intervalMinutes) : null;
  if (minutes != null && !Number.isInteger(minutes)) {
    return { ok: false, error: "間隔は整数の分で入れてください" };
  }

  try {
    const row = await addInstaTarget(
      { handle: input.handle, tier, intervalMinutes: minutes, note: input.note },
      user.clearance,
      user.id,
    );
    await logAudit({
      actorId: user.id,
      action: "insta.target.add",
      targetType: "InstaWatchTarget",
      targetId: row.id,
      metadata: { handle: row.handle, tier: row.tier, intervalMinutes: row.intervalMinutes },
    });
    revalidatePath("/admin/insta");
    return { ok: true, message: `${row.handle} を追加しました（${row.effectiveMinutes} 分ごと）` };
  } catch (e) {
    if (e instanceof InstaTargetError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function toggleInstaTargetAction(id: string, enabled: boolean): Promise<InstaActionState> {
  const user = await requireRole(["admin"]);
  await setInstaTargetEnabled(id, enabled, user.clearance, user.id);
  await logAudit({
    actorId: user.id,
    action: enabled ? "insta.target.enable" : "insta.target.disable",
    targetType: "InstaWatchTarget",
    targetId: id,
  });
  revalidatePath("/admin/insta");
  return { ok: true, message: enabled ? "監視を再開しました" : "監視から外しました" };
}

export async function deleteInstaTargetAction(id: string): Promise<InstaActionState> {
  const user = await requireRole(["admin"]);
  await deleteInstaTarget(id, user.clearance);
  await logAudit({
    actorId: user.id,
    action: "insta.target.delete",
    targetType: "InstaWatchTarget",
    targetId: id,
  });
  revalidatePath("/admin/insta");
  return { ok: true, message: "削除しました" };
}

export async function setInstaAccountAction(input: {
  username: string;
  note: string;
}): Promise<InstaActionState> {
  const user = await requireRole(["admin"]);
  try {
    const acc = await setInstaAccount(input, user.clearance, user.id);
    await logAudit({
      actorId: user.id,
      action: "insta.account.set",
      targetType: "InstaAccount",
      targetId: "singleton",
      // **パスワードは扱わないので、監査に残るのもユーザー名だけ**
      metadata: { username: acc.username },
    });
    revalidatePath("/admin/insta");
    return { ok: true, message: `${acc.username} を登録しました` };
  } catch (e) {
    if (e instanceof InstaTargetError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * story ジョブを手で作る (#178)。URL でもハンドルでもよい。
 * bot を経ずに iPad 側の動作を確かめる用。作れたら空いていれば即 Pushcut で送る。
 */
export async function createInstaJobAction(input: { url: string }): Promise<InstaActionState> {
  const user = await requireRole(["admin"]);
  try {
    const res = await createStoryJob({ url: input.url }, { id: user.id, clearance: user.clearance });
    revalidatePath("/admin/insta");
    if (res.existing) {
      return { ok: true, message: `${res.job.handle} のジョブは進行中です (${res.job.status})` };
    }
    if (res.dispatch == null) {
      return { ok: true, message: `${res.job.handle} のジョブを積みました。前のジョブが終わったら送ります` };
    }
    return res.dispatch.ok
      ? { ok: true, message: `${res.job.handle} のジョブを iPad に送りました` }
      : { ok: false, error: `ジョブは作りましたが送れませんでした: ${res.dispatch.error}` };
  } catch (e) {
    if (e instanceof InstaTargetError || e instanceof InstaJobError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 取り残された pending の再送や失効の回収を手で起こす */
export async function tickInstaJobsAction(): Promise<InstaActionState> {
  await requireRole(["admin"]);
  try {
    const res = await tickStoryJobs();
    revalidatePath("/admin/insta");
    if (!res.dispatcherConfigured) return { ok: false, error: DISPATCHER_NOT_CONFIGURED_MESSAGE };
    if (res.dispatch && !res.dispatch.ok) return { ok: false, error: `送信に失敗: ${res.dispatch.error}` };
    const parts = [
      res.expired.length ? `失効 ${res.expired.length} 件` : null,
      res.dispatchedId ? "1 件を iPad に送りました" : "送るジョブはありません",
    ].filter(Boolean);
    return { ok: true, message: parts.join(" / ") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
