import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { runMentionWatch } from "@/lib/x-mentions/run";

// 監視語ごとに X API を最大 2 ページ + ヒット 1 件ごとに Discord へ 1 リクエスト (0.5 秒間隔)。
// 監視語が数語、ヒットが数十件でも 1 分に収まる
export const maxDuration = 60;

/**
 * X 言及監視の日次実行。`vercel.json` の crons から 09:00 JST に呼ばれる。
 * `/api/cron/status` と同じく `CRON_SECRET` の Bearer で保護し、未設定なら 503。
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const result = await runMentionWatch();
  const failed = result.watches.filter((w) => w.error);
  if (failed.length || result.notifyError) {
    console.error(
      `[mentions] ${failed.map((w) => `${w.query}: ${w.error}`).join(" / ")}${result.notifyError ? ` / 通知: ${result.notifyError}` : ""}`
    );
  }
  return NextResponse.json({
    startedAt: result.startedAt.toISOString(),
    newHits: result.newHits,
    notified: result.notified,
    notifyError: result.notifyError,
    discordConfigured: result.discordConfigured,
    watches: result.watches,
  });
}
