import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { markTiktokVideoNotified } from "@/lib/domain/tiktok";
import { handleTiktokError } from "@/lib/tiktok/api";
import { VIDEO_ID_PATTERN } from "@/lib/tiktok/targets";

type Params = { params: Promise<{ videoId: string }> };

/** Discord に送れたことを台帳に残す (#179)。本文は無い */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { videoId } = await params;
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }
  try {
    await markTiktokVideoNotified(videoId, auth.clearance);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleTiktokError(e);
  }
}
