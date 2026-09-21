import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { tickStoryJobs } from "@/lib/domain/insta-jobs";

// 失効の回収 (数クエリ) と Pushcut への送信 1 回 (15 秒でタイムアウト)
export const maxDuration = 30;

/**
 * story ジョブ (#178) のキューを進める。`vercel.json` の crons から 10 分ごとに呼ばれる。
 *
 * 通常は作成・完了・失敗のたびに進むので、ここは **iPad が長く不在だったとき・Pushcut が
 * 落ちていたときの保険**: 失効したジョブを failed にし、取り残された pending を送り直す。
 * `/api/cron/status` (監視の評価。60 秒の予算をほぼ使い切る) とは分けている。
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const result = await tickStoryJobs();
  return NextResponse.json({
    expired: result.expired,
    dispatchedId: result.dispatchedId,
    dispatch: result.dispatch,
    dispatcherConfigured: result.dispatcherConfigured,
  });
}
