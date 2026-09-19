import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { ingestAllProviders } from "@/lib/costs/providers";

// プロバイダ 2 社 ×「コスト + 内訳 + キー名 (プロジェクト数ぶん、並列)」。
// 1 リクエスト 15 秒でタイムアウトするので、直列に数本並んでも収まる長さにしておく
export const maxDuration = 180;

/** 確定遅れに備えて毎回さかのぼって上書きする日数 */
const INGEST_DAYS = 3;

/**
 * LLM コストの日次取り込み。`vercel.json` の crons から 1 日 1 回呼ばれる。
 *
 * `/api/cron/status` と同じく `CRON_SECRET` の Bearer で保護し、未設定なら 503。
 * Admin キーが無いプロバイダは黙ってスキップする (/status に unknown で出る)。
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const results = await ingestAllProviders(INGEST_DAYS);
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.error(`[costs] 取り込みに失敗: ${failed.map((f) => `${f.provider}: ${f.error}`).join(" / ")}`);
  }
  return NextResponse.json({ results });
}

