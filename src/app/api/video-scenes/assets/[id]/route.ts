import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getVideoScenes, sceneProgress } from "@/lib/domain/video-scenes";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "ログインしてください" }, { status: 401 });
  const { id } = await params;
  if (new URL(request.url).searchParams.has("progress")) {
    return NextResponse.json({ tasks: await sceneProgress(session.user.clearance, id) }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const result = await getVideoScenes(session.user.clearance, id);
  return result ? NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } })
    : NextResponse.json({ error: "動画が見つかりません" }, { status: 404 });
}
