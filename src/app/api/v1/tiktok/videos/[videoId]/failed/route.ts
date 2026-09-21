import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/api-auth";
import { markTiktokVideoFailed } from "@/lib/domain/tiktok";
import { handleTiktokError, readJsonBody } from "@/lib/tiktok/api";
import { ERROR_MAX, VIDEO_ID_PATTERN } from "@/lib/tiktok/targets";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ videoId: string }> };

/** DL か登録の失敗を台帳に残す (#179)。attempts が上限に達すると次の周では返さなくなる */
export const dynamic = "force-dynamic";

const Body = z.object({ error: z.string().min(1).max(ERROR_MAX) }).strict();

export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { videoId } = await params;
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = Body.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  try {
    const result = await markTiktokVideoFailed(videoId, parsed.data.error, auth.clearance);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return handleTiktokError(e);
  }
}
