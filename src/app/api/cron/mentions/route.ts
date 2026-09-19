import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { runMentionWatch } from "@/lib/x-mentions/run";

// 監視語ごとに X API を最大 2 ページ (429 なら最長 90 秒待つ) + ヒット 1 件ごとに Discord へ
// 1 リクエスト (0.5 秒間隔、1 回 60 件まで)。途中で切られると送ったのに notifiedAt が戻って
// 二重送信になるので、余裕を持って 5 分
export const maxDuration = 300;

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
    notifyRemaining: result.notifyRemaining,
    notifyError: result.notifyError,
    discordConfigured: result.discordConfigured,
    watches: result.watches,
  });
}
