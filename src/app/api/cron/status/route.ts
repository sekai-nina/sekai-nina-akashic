import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { evaluateAllChecks } from "@/lib/status/evaluate";
import { countByLevel } from "@/lib/status/judge";

// GitHub の tree 取得 (~300KB) と十数本のクエリを含む。各チェックは 15 秒、全体は 40 秒の
// 予算で打ち切るので、保存と通知まで含めて 1 分に収まる
export const maxDuration = 60;

/**
 * パイプライン監視の定期評価。`vercel.json` の crons から 15 分ごと (毎時 7・22・37・52 分) に呼ばれる。
 *
 * 0・15・30・45 分は文字起こし・OCR の cron (最長 300 秒) と重なり、同じ時刻に走ると評価が遅れて
 * チェックが 15 秒の上限に当たり「評価そのもの」が注意と正常を往復した (#433)。7 分ずらして避ける。
 * 10 分おきの insta-jobs とも重ならない
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

