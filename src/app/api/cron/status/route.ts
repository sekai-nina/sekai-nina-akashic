import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { evaluateAllChecks } from "@/lib/status/evaluate";
import { countByLevel } from "@/lib/status/judge";

// GitHub の tree 取得 (~800KB) と十数本のクエリを含む。各チェックは 20 秒で打ち切るので
// 全体は 1 分に収まる
export const maxDuration = 60;

/**
 * パイプライン監視の定期評価。`vercel.json` の crons から 15 分ごとに呼ばれる。
 *
 * Vercel は `CRON_SECRET` を `Authorization: Bearer` に載せて呼ぶので、それと一致しない
 * 呼び出しは拒否する。未設定なら fail-closed (誰でも評価と Discord 通知を起こせてしまうため)。
 * 手で叩くときも同じヘッダを付ける。
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const result = await evaluateAllChecks({ notify: true });
  if (result.skipped) {
    return NextResponse.json({ skipped: true, lastEvaluatedAt: result.lastEvaluatedAt.toISOString() });
  }
  return NextResponse.json({
    evaluatedAt: result.evaluatedAt.toISOString(),
    counts: countByLevel(result.checks.map((c) => c.state.status)),
    notified: result.notified.length,
    notifyError: result.notifyError,
    failed: result.failedKeys,
    prunedRuns: result.prunedRuns,
    checks: result.checks.map((c) => ({ key: c.state.key, status: c.state.status, summary: c.state.summary })),
  });
}

