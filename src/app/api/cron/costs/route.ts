import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ingestAllProviders } from "@/lib/costs/providers";

// プロバイダ 2 社 × 3 リクエスト (各 15 秒でタイムアウト) + 書き込み。余裕を持たせる
export const maxDuration = 120;

/** 確定遅れに備えて毎回さかのぼって上書きする日数 */
const INGEST_DAYS = 3;

/**
 * LLM コストの日次取り込み。`vercel.json` の crons から 1 日 1 回呼ばれる。
 *
 * `/api/cron/status` と同じく `CRON_SECRET` の Bearer で保護し、未設定なら 503。
 * Admin キーが無いプロバイダは黙ってスキップする (/status に unknown で出る)。
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "cron is not configured" }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await ingestAllProviders(INGEST_DAYS);
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.error(`[costs] 取り込みに失敗: ${failed.map((f) => `${f.provider}: ${f.error}`).join(" / ")}`);
  }
  return NextResponse.json({ results });
}

/** 長さが違えば即 false、同じなら定数時間で比較する */
function bearerMatches(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
