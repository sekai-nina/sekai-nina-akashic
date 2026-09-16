"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { logAudit } from "@/lib/domain/audit";
import { isDiscordConfigured, postDiscord } from "@/lib/status/discord";
import { evaluateAllChecks } from "@/lib/status/evaluate";
import { countByLevel } from "@/lib/status/judge";
import { STATUS_LEVEL_LABELS, formatRelative } from "@/lib/utils";
import type { StatusLevel } from "@prisma/client";

export type StatusActionState = { ok: true; message: string } | { ok: false; error: string };

/**
 * 全チェックを今すぐ評価する。**admin のみ。**
 *
 * cron と同じ処理で、遷移があれば Discord にも流す (直したあとに押して復旧の一報を出す用途)。
 * 状態は保存されるので、評価後はページを作り直して最新を見せる。
 */
export async function evaluateNowAction(): Promise<StatusActionState> {
  const user = await requireRole(["admin"]);
  try {
    const result = await evaluateAllChecks({ notify: true });
    if (result.skipped) {
      return { ok: false, error: `${formatRelative(result.lastEvaluatedAt)}に評価済みです。少し待ってから押してください` };
    }
    await logAudit({
      actorId: user.id,
      action: "status.evaluate",
      targetType: "StatusCheckState",
      targetId: "all",
      metadata: { checks: result.checks.length, notified: result.notified.length, notifyError: result.notifyError },
    });
    revalidatePath("/status");
    const counts = countByLevel(result.checks.map((c) => c.state.status));
    const breakdown = (["ok", "warn", "error", "unknown"] as StatusLevel[])
      .map((l) => `${STATUS_LEVEL_LABELS[l]} ${counts[l]}`)
      .join(" / ");
    const parts = [`評価しました (${breakdown})`];
    if (result.notified.length) parts.push(`Discord に ${result.notified.length} 件通知`);
    if (result.notifyError) return { ok: false, error: `${parts[0]}。通知に失敗: ${result.notifyError}` };
    return { ok: true, message: parts.join("。") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Discord webhook の疎通確認。**admin のみ。** 状態は変えない */
export async function testNotificationAction(): Promise<StatusActionState> {
  const user = await requireRole(["admin"]);
  if (!isDiscordConfigured()) return { ok: false, error: "DISCORD_STATUS_WEBHOOK_URL が設定されていません" };
  try {
    await postDiscord(`🔔 akashic /status の通知テスト (${user.name} が送信)`);
    return { ok: true, message: "Discord にテスト通知を送りました" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
