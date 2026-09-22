import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/api-auth";
import { registerTiktokVideo } from "@/lib/domain/tiktok";
import { handleTiktokError, readJsonBody } from "@/lib/tiktok/api";
import { VIDEO_ID_PATTERN } from "@/lib/tiktok/targets";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ videoId: string }> };

/**
 * `POST /upload` で作ったアセットを TikTok の動画として整える (#179)。
 * タイトル・説明・投稿時刻・出典・メンバーの紐付け・サムネイルは akashic 側で付ける。
 * cover の取得 (10 秒) + sharp + R2 + 数回のトランザクションが載るので上限を伸ばす
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ assetId: z.string().min(1).max(64) }).strict();

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
    const result = await registerTiktokVideo(videoId, parsed.data.assetId, {
      id: auth.id,
      clearance: auth.clearance,
    });
    return NextResponse.json(result);
  } catch (e) {
    return handleTiktokError(e);
  }
}
