import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireApiAuth } from "@/lib/api-auth";
import { getSceneFile, getSceneSource } from "@/lib/domain/video-scenes";
import { sceneMediaResponse } from "@/lib/video-scenes/media-response";
import { SCENE_WORKER_PERMISSION } from "@/lib/video-scenes/policy";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = request.headers.has("authorization") ? null : await auth();
  const actor = session?.user ?? await requireApiAuth(request, [SCENE_WORKER_PERMISSION, "read"]);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const source = new URL(request.url).searchParams.get("source") === "1";
  const file = source ? await getSceneSource(actor.clearance, id) : await getSceneFile(actor.clearance, id);
  if (!file) return NextResponse.json({ error: "ファイルが見つかりません" }, { status: 404 });
  return sceneMediaResponse(request, file);
}
