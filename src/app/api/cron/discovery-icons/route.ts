import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { autoGenerateFoodIcons, FOOD_ICON_MAX_FAILURES } from "@/lib/domain/discovery-icons";
import { isR2Configured } from "@/lib/r2";
import { recordJobRun } from "@/lib/status/jobs";
import { DISCOVERY_ICON_JOB_KEY } from "@/lib/status/types";

// 基準画像の読み込み (上限 30 秒) のあと、1 枚 15〜20 秒 (上限 90 秒) を並べて作る (FOOD_ICON_BATCH_SIZE)
export const maxDuration = 180;

const INTERVAL_SEC = 15 * 60;
const JOB_NAME = "今日の発見のアイコン (15 分)";

/**
 * 今日の発見の食べ物のうち、アイコンがまだの名前にイラストのアイコンを作る (#436)。
 * 対象は外部 AI に出してよいブログ (internal 以下) に出てくる名前だけ。作ったものはサイトの次のビルドで出る。
 * 3 回作れなかった名前は外し、/status に出す (確認ページの「材料と分類」から作り直せる)。
 * `vercel.json` の crons から 15 分ごと (他の 15 分 cron と重ねない)。`OPENAI_API_KEY` か R2 が未設定なら何もしない。
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;
  if (!process.env.OPENAI_API_KEY || !isR2Configured()) {
    return NextResponse.json({ skipped: "OPENAI_API_KEY か R2 が未設定です" });
  }

  const startedAt = Date.now();
  try {
    const r = await autoGenerateFoodIcons();
    for (const f of r.failed) console.log(`[discovery-icons] ${f.name}: ${f.message}`);
    console.log(`[discovery-icons] 試した ${r.attempted} / 作った ${r.generated} / あきらめた ${r.givenUp}`);
    // 件数だけを /status (ログイン済み全員) に出す。名前は出さない
    await recordJobRun(DISCOVERY_ICON_JOB_KEY, {
      status: r.givenUp > 0 ? "error" : "ok",
      message:
        `試した ${r.attempted} / 作った ${r.generated}` +
        (r.givenUp > 0 ? ` / ${FOOD_ICON_MAX_FAILURES} 回作れなかった ${r.givenUp} 個 (/discoveries の材料と分類で作り直す)` : ""),
      count: r.generated,
      durationMs: Date.now() - startedAt,
      intervalSec: INTERVAL_SEC,
      name: JOB_NAME,
    }).catch((e) => console.error(`[discovery-icons] ハートビートの記録に失敗: ${e instanceof Error ? e.message : e}`));
    return NextResponse.json(r);
  } catch (error) {
    console.error(`[discovery-icons] ${error instanceof Error ? error.message : String(error)}`);
    await recordJobRun(DISCOVERY_ICON_JOB_KEY, {
      status: "error",
      message: "失敗しました (詳細は Vercel のログ)",
      durationMs: Date.now() - startedAt,
      intervalSec: INTERVAL_SEC,
      name: JOB_NAME,
    }).catch(() => {});
    return NextResponse.json({ error: "今日の発見のアイコン作りに失敗しました" }, { status: 500 });
  }
}
