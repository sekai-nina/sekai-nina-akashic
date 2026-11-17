import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getSceneSource } from "@/lib/domain/video-scenes";
import { sceneMediaResponse } from "@/lib/video-scenes/media-response";
import { SCENE_WORKER_PERMISSION } from "@/lib/video-scenes/policy";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Cookie/MFA を前提にしない専用のキー認証経路。元動画の RLS は必ず通す。
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireApiAuth(request, [SCENE_WORKER_PERMISSION, "read"]);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const file = await getSceneSource(actor.clearance, id);
  if (!file) return NextResponse.json({ error: "ファイルが見つかりません" }, { status: 404 });
  return sceneMediaResponse(request, file);
}
