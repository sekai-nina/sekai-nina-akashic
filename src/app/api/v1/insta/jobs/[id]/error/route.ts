import { NextResponse } from "next/server";
import { z } from "zod";
import { failStoryJob } from "@/lib/domain/insta-jobs";
import { instaJobErrorResponse, instaJobToJson, requireInstaJobAuth } from "@/lib/insta/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

// 失敗の報告で次のジョブを送る (Pushcut は 15 秒でタイムアウト)
export const maxDuration = 30;

// 長いエラー文は切って受ける (弾くと processing のまま 20 分待つことになる)
const Body = z
  .object({ error: z.string().optional().default("").transform((s) => s.slice(0, 500)) })
  .strict();

/** iPad からの失敗報告。failed にして次の pending ジョブを送る */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireInstaJobAuth(request, "worker");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown = {};
  const text = await request.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  try {
    const res = await failStoryJob(id, parsed.data.error, auth.clearance);
    return NextResponse.json({ ...instaJobToJson(res.job), nextDispatchedId: res.next.dispatchedId });
  } catch (e) {
    return instaJobErrorResponse(e);
  }
}
