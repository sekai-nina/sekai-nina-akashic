"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { logAudit } from "@/lib/domain/audit";
import {
  TiktokTargetError,
  addTiktokTarget,
  deleteTiktokTarget,
  requeueFailedTiktokVideos,
  requeueTiktokVideo,
  setTiktokTargetEnabled,
} from "@/lib/domain/tiktok";

export type TiktokActionState = { ok: true; message: string } | { ok: false; error: string };

function fail(e: unknown): TiktokActionState {
  if (e instanceof TiktokTargetError) return { ok: false, error: e.message };
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

export async function addTiktokTargetAction(input: {
  handle: string;
  sourceName: string;
  official: boolean;
  captionFilter: string;
  intervalMinutes: string;
  note: string;
}): Promise<TiktokActionState> {
  const user = await requireRole(["admin"]);
  const minutes = Number(input.intervalMinutes);
  if (!Number.isInteger(minutes)) return { ok: false, error: "間隔は整数の分で入れてください" };

  try {
    const row = await addTiktokTarget(
      {
        handle: input.handle,
        sourceName: input.sourceName,
        official: input.official,
        captionFilter: input.captionFilter,
        intervalMinutes: minutes,
        note: input.note,
      },
      user.clearance,
      user.id,
    );
    await logAudit({
      actorId: user.id,
      action: "tiktok.target.add",
      targetType: "TiktokWatchTarget",
      targetId: row.id,
      metadata: {
        handle: row.handle,
        intervalMinutes: row.intervalMinutes,
        official: row.official,
        captionFilter: row.captionFilter,
      },
    });
    revalidatePath("/admin/tiktok");
    return { ok: true, message: `${row.handle} を追加しました（${row.intervalMinutes} 分ごと）` };
  } catch (e) {
    return fail(e);
  }
}

export async function toggleTiktokTargetAction(id: string, enabled: boolean): Promise<TiktokActionState> {
  const user = await requireRole(["admin"]);
  try {
    await setTiktokTargetEnabled(id, enabled, user.clearance, user.id);
    await logAudit({
      actorId: user.id,
      action: enabled ? "tiktok.target.enable" : "tiktok.target.disable",
      targetType: "TiktokWatchTarget",
      targetId: id,
    });
    revalidatePath("/admin/tiktok");
    return { ok: true, message: enabled ? "監視を再開しました" : "監視から外しました" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTiktokTargetAction(id: string): Promise<TiktokActionState> {
  const user = await requireRole(["admin"]);
  try {
    await deleteTiktokTarget(id, user.clearance);
    await logAudit({
      actorId: user.id,
      action: "tiktok.target.delete",
      targetType: "TiktokWatchTarget",
      targetId: id,
    });
    revalidatePath("/admin/tiktok");
    return { ok: true, message: "削除しました" };
  } catch (e) {
    return fail(e);
  }
}

/** 失敗した動画の再試行、または初回接触で飛ばした動画を 1 本取り込む */
export async function requeueTiktokVideoAction(id: string): Promise<TiktokActionState> {
  const user = await requireRole(["admin"]);
  try {
    const changed = await requeueTiktokVideo(id, user.clearance);
    if (!changed) return { ok: false, error: "この状態の動画は戻せません（登録済みか取得待ち）" };
    await logAudit({
      actorId: user.id,
      action: "tiktok.video.requeue",
      targetType: "TiktokVideo",
      targetId: id,
    });
    revalidatePath("/admin/tiktok");
    return { ok: true, message: "次の巡回で取り込みます" };
  } catch (e) {
    return fail(e);
  }
}

/** 対象の失敗をまとめて戻す (一覧に出ない古い失敗も含む) */
export async function requeueFailedTiktokVideosAction(targetId: string): Promise<TiktokActionState> {
  const user = await requireRole(["admin"]);
  try {
    const n = await requeueFailedTiktokVideos(targetId, user.clearance);
    await logAudit({
      actorId: user.id,
      action: "tiktok.video.requeue_failed",
      targetType: "TiktokWatchTarget",
      targetId,
      metadata: { count: n },
    });
    revalidatePath("/admin/tiktok");
    return { ok: true, message: `${n} 本を次の巡回で取り直します` };
  } catch (e) {
    return fail(e);
  }
}
