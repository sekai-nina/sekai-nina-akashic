"use server";

import { revalidatePath } from "next/cache";
import type { InstaWatchTier } from "@prisma/client";
import { requireRole } from "@/lib/auth/require-role";
import { setInstaAccount } from "@/lib/domain/insta-account";
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
