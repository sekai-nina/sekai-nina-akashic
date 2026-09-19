import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { UsageDateError, UsageReportSchema, recordUsage } from "@/lib/costs/usage";
import { formatZodError } from "@/lib/zod-error";

/**
 * LLM の利用量の自己申告。bot / ワーカー / akashic 自身が 1 回 (またはまとめた分) ごとに送る。
 *
 * akashic が単価表 (`src/lib/costs/pricing.ts`) で USD に換算し、日次 × モデル × 機能に積む。
 * **単価表に無いモデルは金額 null でトークンだけ残る** (/costs に「価格未登録」と出る)。
 * 監査ログには残さない (呼び出しのたびに 1 行増えるため)。
 */
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = UsageReportSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  try {
    return NextResponse.json(await recordUsage(parsed.data));
  } catch (e) {
    if (e instanceof UsageDateError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
