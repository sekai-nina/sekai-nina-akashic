import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * `/api/cron/*` の入口。Vercel は `CRON_SECRET` を `Authorization: Bearer` に載せて呼ぶので、
 * それと一致しない呼び出しは拒否する。未設定なら fail-closed (誰でも評価や Discord 通知を
 * 起こせてしまうため)。手で叩くときも同じヘッダを付ける。
 *
 * 通れば null、弾くならそのまま返すべき NextResponse を返す。
 */
export function authorizeCron(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "cron is not configured" }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/** 長さが違えば即 false、同じなら定数時間で比較する */
function bearerMatches(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
