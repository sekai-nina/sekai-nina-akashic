import { NextResponse } from "next/server";
import { z } from "zod";
import { createStoryUploadUrl } from "@/lib/domain/insta-jobs";
import { instaJobErrorResponse, requireInstaJobAuth } from "@/lib/insta/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

const Body = z
  .object({
    filename: z.string().min(1).max(200),
    mimeType: z.string().max(100).optional().default(""),
  })
  .strict();

/**
 * iPad が Google Drive に直接 PUT するための URL を発行する。
 *
 * Vercel の本文上限 (4.5MB) を避ける経路。返った `uploadUrl` にファイルをそのまま PUT すると
 * Drive が `{ id, name, ... }` を返すので、その `id` を `result` に `driveFileId` として送る。
 * URL は Drive のセッションで守られている (Authorization は要らない・1 回きり)。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireInstaJobAuth(request, "worker");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  try {
    const res = await createStoryUploadUrl(id, parsed.data, auth.clearance);
    return NextResponse.json(res);
  } catch (e) {
    return instaJobErrorResponse(e);
  }
}
