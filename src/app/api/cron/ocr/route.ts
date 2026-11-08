import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { autoOcr } from "@/lib/domain/ocr";
import { isOcrConfigured } from "@/lib/ocr/claude";
import { recordJobRun } from "@/lib/status/jobs";
import { OCR_JOB_KEY } from "@/lib/status/types";

// 1 件あたり Drive からの取得と Claude の応答で 10〜40 秒。BUDGET_MS を過ぎたら次の回に回す
export const maxDuration = 300;

const INTERVAL_SEC = 15 * 60;
const JOB_NAME = "画像の OCR (15 分)";
// 1 回で回す上限。雑誌 1 冊 (約 100 ページ) は数時間かけて片付く
const BATCH_LIMIT = 10;
// 新しい 1 件を始めてよいのはここまで。1 件は最悪 Drive 30 秒 + Claude 120 秒 × 2 (リトライ) かかる
const BUDGET_MS = 120_000;

/**
 * タグ「雑誌」の画像と「まとめて OCR」で頼まれた画像を Claude で OCR する (#379)。
 * `vercel.json` の crons から 15 分ごと。`ANTHROPIC_API_KEY` が未設定なら何もしない。
 * `/status` に `cron.ocr` のハートビートを残す。
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;
  if (!isOcrConfigured()) return NextResponse.json({ skipped: "ANTHROPIC_API_KEY が未設定です" });

  const startedAt = Date.now();
  try {
    const r = await autoOcr({ limit: BATCH_LIMIT, budgetMs: BUDGET_MS });
    console.log(
      `[ocr] 保存 ${r.done} 件 / 文字なし ${r.empty} 件 / 失敗 ${r.failed} 件 / 次の回へ ${r.retry} 件 / 残り ${r.remaining} 件`,
    );
    // 対象は internal 以下の画像だけなので、件数は /status (ログイン済み全員) に出してよい
    await recordJobRun(OCR_JOB_KEY, {
      status: r.stopped || (r.retry > 0 && r.done + r.empty + r.failed === 0) ? "error" : "ok",
      message: `保存 ${r.done} / 空 ${r.empty} / 失敗 ${r.failed} / 再試行 ${r.retry}${r.stopped ? " (打ち切り)" : ""} / 残り ${r.remaining}`,
      count: r.done + r.empty + r.failed,
      durationMs: Date.now() - startedAt,
      intervalSec: INTERVAL_SEC,
      name: JOB_NAME,
    }).catch((e) => console.error(`[ocr] ハートビートの記録に失敗: ${e instanceof Error ? e.message : e}`));
    return NextResponse.json(r);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ocr] ${message}`);
    await recordJobRun(OCR_JOB_KEY, {
      status: "error", message: "失敗しました (詳細は Vercel のログ)", durationMs: Date.now() - startedAt, intervalSec: INTERVAL_SEC, name: JOB_NAME,
    }).catch(() => {});
    return NextResponse.json({ error: "OCR に失敗しました" }, { status: 500 });
  }
}
