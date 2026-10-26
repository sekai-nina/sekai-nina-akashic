import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { autoTranscribe } from "@/lib/domain/transcribe";
import { recordJobRun } from "@/lib/status/jobs";
import { TRANSCRIBE_JOB_KEY } from "@/lib/status/types";
import { isGroqConfigured } from "@/lib/transcribe/groq";

// 1 件あたり Drive からの取得 (〜25 MB) と Groq の応答で数秒。BUDGET_MS で打ち切って次の回に回す
export const maxDuration = 300;

const INTERVAL_SEC = 15 * 60;
const JOB_NAME = "トークの文字起こし (15 分)";
// Groq の無料枠は 20 回 / 分。1 件 2〜3 秒で回るので、1 回の cron で 1 分に収まる数にする
const BATCH_LIMIT = 15;
const BUDGET_MS = 240_000;

/**
 * 坂井新奈のトークの音声・動画を Groq で文字起こしする (#282)。`vercel.json` の crons から 15 分ごと。
 * `GROQ_API_KEY` が未設定なら何もしない。`/status` に `cron.transcribe` のハートビートを残す。
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;
  if (!isGroqConfigured()) return NextResponse.json({ skipped: "GROQ_API_KEY が未設定です" });

  const startedAt = Date.now();
  try {
    const r = await autoTranscribe({ limit: BATCH_LIMIT, budgetMs: BUDGET_MS });
    console.log(
      `[transcribe] 保存 ${r.done} 件 / 喋っていない ${r.empty} 件 / 失敗 ${r.failed} 件 / 次の回へ ${r.retry} 件 / 残り ${r.remaining} 件`,
    );
    // 対象は internal 以下のトークだけなので、件数は /status (ログイン済み全員) に出してよい
    await recordJobRun(TRANSCRIBE_JOB_KEY, {
      // 1 件も進まず全部が再試行に回った (キーの誤り・Groq の障害) ときだけ異常にする
      status: r.retry > 0 && r.done + r.empty + r.failed === 0 ? "error" : "ok",
      message: `保存 ${r.done} / 空 ${r.empty} / 失敗 ${r.failed} / 再試行 ${r.retry} / 残り ${r.remaining}`,
      count: r.done + r.empty + r.failed,
      durationMs: Date.now() - startedAt,
      intervalSec: INTERVAL_SEC,
      name: JOB_NAME,
    }).catch((e) => console.error(`[transcribe] ハートビートの記録に失敗: ${e instanceof Error ? e.message : e}`));
    return NextResponse.json(r);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[transcribe] ${message}`);
    await recordJobRun(TRANSCRIBE_JOB_KEY, {
      status: "error", message: "失敗しました (詳細は Vercel のログ)", durationMs: Date.now() - startedAt, intervalSec: INTERVAL_SEC, name: JOB_NAME,
    }).catch(() => {});
    return NextResponse.json({ error: "文字起こしに失敗しました" }, { status: 500 });
  }
}
