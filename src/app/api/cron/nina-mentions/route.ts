import { NextResponse } from "next/server";
import { prismaInternal } from "@/lib/db";
import { authorizeCron } from "@/lib/cron/auth";
import { refreshNinaMentions } from "@/lib/domain/nina-mentions";
import { recordJobRun } from "@/lib/status/jobs";
import { NINA_MENTIONS_JOB_KEY } from "@/lib/status/types";

// PGroonga の検索 1 回 (温まって約 1.4 秒) と差分の UPDATE。別名を足した直後は UPDATE が数千件になる
export const maxDuration = 60;

const INTERVAL_SEC = 15 * 60;
const JOB_NAME = "新奈への言及の付け直し (15 分)";

/**
 * Asset.mentionsNina (本文が坂井新奈に言及しているか) を付け直す。`vercel.json` の crons から
 * 15 分ごとに呼ばれる。PGroonga の検索 1 回 (約 1.4 秒) と差分の UPDATE だけなので軽い。
 * `/status` に `cron.nina_mentions` のハートビートを残す。
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const startedAt = Date.now();
  try {
    const result = await refreshNinaMentions(prismaInternal, { apply: true });
    console.log(`[nina-mentions] 一致 ${result.matched} 件 / 付けた ${result.added.length} 件 / 外した ${result.removed.length} 件`);
    await recordJobRun(NINA_MENTIONS_JOB_KEY, {
      status: "ok",
      // Job は非保護テーブルでログイン済み全員の /status に出る。件数は RLS を通さずに数えた値で、
      // 上位機密のアセットも含むので載せない (詳細は管理者だけが見る Vercel のログへ)
      message: "",
      durationMs: Date.now() - startedAt,
      intervalSec: INTERVAL_SEC,
      name: JOB_NAME,
    }).catch((e) => console.error(`[nina-mentions] ハートビートの記録に失敗: ${e instanceof Error ? e.message : e}`));
    return NextResponse.json({ matched: result.matched, added: result.added.length, removed: result.removed.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[nina-mentions] ${message}`);
    await recordJobRun(NINA_MENTIONS_JOB_KEY, {
      status: "error", message: "失敗しました (詳細は Vercel のログ)", durationMs: Date.now() - startedAt, intervalSec: INTERVAL_SEC, name: JOB_NAME,
    }).catch(() => {});
    return NextResponse.json({ error: "言及の付け直しに失敗しました" }, { status: 500 });
  }
}
