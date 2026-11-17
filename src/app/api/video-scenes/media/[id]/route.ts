import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSceneFile, getSceneSource } from "@/lib/domain/video-scenes";
import { sceneMediaResponse } from "@/lib/video-scenes/media-response";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const actor = session?.user;
  if (!actor) return NextResponse.json({ error: "ログインしてください" }, { status: 401 });
  const { id } = await params;
  const source = new URL(request.url).searchParams.get("source") === "1";
  const file = source ? await getSceneSource(actor.clearance, id) : await getSceneFile(actor.clearance, id);
  if (!file) return NextResponse.json({ error: "ファイルが見つかりません" }, { status: 404 });
  return sceneMediaResponse(request, file);
}
