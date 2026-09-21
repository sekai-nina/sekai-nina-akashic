import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { getEnabledTiktokTargets } from "@/lib/domain/tiktok";

/**
 * tiktok-watch が読む監視対象の一覧 (#179)。
 *
 * 読むだけなので read / write の別は問わない (`/api/v1/insta/targets` と同じ)。
 * bot 側は最後に読めた一覧を保持する前提で、ここが一時的に落ちても巡回は止まらない
 * (ただし台帳が akashic にあるので、報告できない周は DL もしない)。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await authenticateApiKey(request);
  if (!user) {
    return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401 });
  }
  const targets = await getEnabledTiktokTargets(user.clearance);
  return NextResponse.json({ targets }, { headers: { "Cache-Control": "no-store" } });
}
