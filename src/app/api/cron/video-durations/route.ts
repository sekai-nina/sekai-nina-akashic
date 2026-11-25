import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { fillVideoDurations } from "@/lib/domain/video-durations";
import { isDriveEnabled } from "@/lib/drive";
import { recordJobRun } from "@/lib/status/jobs";
import { VIDEO_DURATION_JOB_KEY } from "@/lib/status/types";

// Drive への問い合わせは 1 件 0.1〜0.5 秒。8 並列で 400 件なら 30 秒前後
export const maxDuration = 120;

const INTERVAL_SEC = 15 * 60;
const JOB_NAME = "動画の長さ (15 分)";
const BATCH_LIMIT = 400;
const BUDGET_MS = 60_000;

/**
 * 長さが空の動画を Google Drive の videoMediaMetadata から埋める。ダウンロードはしない。
 * 取り込み側 (bot) は触らず、既存分も新しい取り込みもここで拾う。`vercel.json` の crons から 15 分ごと。
 * `/status` に `cron.video_duration` のハートビートと「長さ不明」の件数を残す。
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;
  if (!isDriveEnabled()) return NextResponse.json({ skipped: "Drive が未設定です" });

  const startedAt = Date.now();
  try {
    const r = await fillVideoDurations({ limit: BATCH_LIMIT, budgetMs: BUDGET_MS });
    console.log(`[video-durations] 保存 ${r.filled} / Drive に長さなし ${r.missing} / 次の回へ ${r.retry} / 残り ${r.remaining} / 長さ不明 ${r.unknown}`);
    await recordJobRun(VIDEO_DURATION_JOB_KEY, {
      status: r.retry > 0 && r.filled + r.missing === 0 ? "error" : "ok",
      message: `保存 ${r.filled} / 長さなし ${r.missing} / 再試行 ${r.retry} / 残り ${r.remaining} / 長さ不明 ${r.unknown}`,
      count: r.filled + r.missing,
      durationMs: Date.now() - startedAt,
      intervalSec: INTERVAL_SEC,
      name: JOB_NAME,
    }).catch((e) => console.error(`[video-durations] ハートビートの記録に失敗: ${e instanceof Error ? e.message : e}`));
    return NextResponse.json(r);
  } catch (error) {
    console.error(`[video-durations] ${error instanceof Error ? error.message : String(error)}`);
    await recordJobRun(VIDEO_DURATION_JOB_KEY, {
      status: "error", message: "失敗しました (詳細は Vercel のログ)", durationMs: Date.now() - startedAt, intervalSec: INTERVAL_SEC, name: JOB_NAME,
    }).catch(() => {});
    return NextResponse.json({ error: "動画の長さの取得に失敗しました" }, { status: 500 });
  }
}
