import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/api-auth";
import { reportTiktokTargetError } from "@/lib/domain/tiktok";
import { handleTiktokError, readJsonBody } from "@/lib/tiktok/api";
import { ERROR_MAX } from "@/lib/tiktok/targets";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ handle: string }> };

/** 巡回そのものの失敗 (profile が開けない等) を対象に残す。成功した報告で消える (#179) */
export const dynamic = "force-dynamic";

const Body = z.object({ error: z.string().min(1).max(ERROR_MAX) }).strict();

export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { handle } = await params;
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = Body.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  try {
    await reportTiktokTargetError(handle, parsed.data.error, auth.clearance);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleTiktokError(e);
  }
}
