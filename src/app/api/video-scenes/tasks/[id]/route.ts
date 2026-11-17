import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sceneTaskStatus } from "@/lib/domain/video-scenes";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "ログインしてください" }, { status: 401 });
  const { id } = await params;
  const task = await sceneTaskStatus(session.user.clearance, id);
  return task ? NextResponse.json(task, { headers: { "Cache-Control": "private, no-store" } })
    : NextResponse.json({ error: "依頼が見つかりません" }, { status: 404 });
}
