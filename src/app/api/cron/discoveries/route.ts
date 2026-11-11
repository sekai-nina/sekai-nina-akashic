import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { autoDraftDiscoveries } from "@/lib/domain/discoveries";
import { DiscoveryAiError, isDiscoveryAiConfigured } from "@/lib/discoveries/llm";
import { recordJobRun } from "@/lib/status/jobs";
import { DISCOVERY_JOB_KEY } from "@/lib/status/types";

// Claude への下書き 1 回 (5 本まで) と分類 1 回。それぞれ最悪 70 秒 × 2 (リトライ) = 280 秒 (AUTO_DRAFT_TIMEOUT_MS)
export const maxDuration = 300;

const INTERVAL_SEC = 15 * 60;
const JOB_NAME = "今日の発見の下書き (15 分)";

/**
 * 新しい「今日の発見」に、発見ごとの行 (材料・できあがる味・確信度) と食べ物の分類を付ける (#432)。
 * bot が今日の発見タグと見出し (annotation) を付けたブログのうち、最近登録されて行がまだ無いものが対象。
 * 3 回試しても行ができないブログは対象から外し、/status に「あきらめた」として出す (`pnpm cli:draft-discoveries` で流す)。
 * `vercel.json` の crons から 15 分ごと。`ANTHROPIC_API_KEY` が未設定なら何もしない。
 * `/status` に `cron.discovery` のハートビートを残す。
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;
  if (!isDiscoveryAiConfigured()) return NextResponse.json({ skipped: "ANTHROPIC_API_KEY が未設定です" });

  const startedAt = Date.now();
  try {
    const r = await autoDraftDiscoveries();
    for (const w of r.warnings) console.log(`[discoveries] ${w.assetId}: ${w.message}`);
    console.log(
      `[discoveries] 試した ${r.attempted} 本 / 保存 ${r.drafted} 本 (${r.rows} 行) / 分類 ${r.foods} 個 / あきらめた ${r.givenUp} 本`,
    );
    // 件数だけを /status (ログイン済み全員) に出す。対象は internal 以下のブログだけ。
    // あきらめたブログがあれば人が CLI を流すまで error にして気づかせる
    await recordJobRun(DISCOVERY_JOB_KEY, {
      status: r.givenUp > 0 ? "error" : "ok",
      message:
        `試した ${r.attempted} / 保存 ${r.drafted} (${r.rows} 行) / 分類 ${r.foods}` +
        (r.givenUp > 0 ? ` / あきらめた ${r.givenUp} 本 (pnpm cli:draft-discoveries で流す)` : ""),
      count: r.rows,
      durationMs: Date.now() - startedAt,
      intervalSec: INTERVAL_SEC,
      name: JOB_NAME,
    }).catch((e) => console.error(`[discoveries] ハートビートの記録に失敗: ${e instanceof Error ? e.message : e}`));
    return NextResponse.json(r);
  } catch (error) {
    const message = error instanceof DiscoveryAiError ? error.message : "失敗しました (詳細は Vercel のログ)";
    console.error(`[discoveries] ${error instanceof Error ? error.message : String(error)}`);
    await recordJobRun(DISCOVERY_JOB_KEY, {
      status: "error", message, durationMs: Date.now() - startedAt, intervalSec: INTERVAL_SEC, name: JOB_NAME,
    }).catch(() => {});
    return NextResponse.json({ error: "今日の発見の下書きに失敗しました" }, { status: 500 });
  }
}
