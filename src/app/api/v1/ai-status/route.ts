import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { getAiSetting } from "@/lib/domain/ai-setting";

/**
 * 案内AI Worker が定期的に見に来るスイッチ。
 *
 * 読むだけなので read / write の別は問わない（Worker の鍵は write のみ）。
 * Worker 側は短いキャッシュと「最後に読めた値」を持っているので、ここが一時的に
 * 落ちても AI は止まらない。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await authenticateApiKey(request);
  if (!user) {
    return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401 });
  }

  const setting = await getAiSetting(user.clearance);
  return NextResponse.json(
    { enabled: setting.enabled },
    { headers: { "Cache-Control": "no-store" } }
  );
}
