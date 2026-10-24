import { NextResponse } from "next/server";
import { prismaInternal } from "@/lib/db";
import { authorizeCron } from "@/lib/cron/auth";
import { refreshNinaMentions } from "@/lib/domain/nina-mentions";
import { recordJobRun } from "@/lib/status/jobs";
import { NINA_MENTIONS_JOB_KEY } from "@/lib/status/types";

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
    const changed = result.added.length + result.removed.length;
    await recordJobRun(NINA_MENTIONS_JOB_KEY, {
      status: "ok",
      message: `一致 ${result.matched} 件 / 付けた ${result.added.length} 件 / 外した ${result.removed.length} 件`,
      count: changed,
      durationMs: Date.now() - startedAt,
      intervalSec: INTERVAL_SEC,
      name: JOB_NAME,
    }).catch((e) => console.error(`[nina-mentions] ハートビートの記録に失敗: ${e instanceof Error ? e.message : e}`));
    return NextResponse.json({ matched: result.matched, added: result.added.length, removed: result.removed.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[nina-mentions] ${message}`);
    await recordJobRun(NINA_MENTIONS_JOB_KEY, {
      status: "error", message, durationMs: Date.now() - startedAt, intervalSec: INTERVAL_SEC, name: JOB_NAME,
    }).catch(() => {});
    return NextResponse.json({ error: "言及の付け直しに失敗しました" }, { status: 500 });
  }
}
