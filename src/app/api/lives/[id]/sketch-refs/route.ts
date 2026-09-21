import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getLive } from "@/lib/domain/lives";
import { liveSketchStore } from "@/lib/domain/live-sketch";
import { deleteSketchRef, uploadSketchRef } from "@/lib/meetgreet/sketch-ref-routes";

type Params = { params: Promise<{ id: string }> };

/** そのライブだけの参考画像 (#150)。処理本体は src/lib/meetgreet/sketch-ref-routes.ts (ミーグリと共用) */
export const maxDuration = 60;

export async function POST(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // **member 以上に限る。** 画面の Server Action (`requireMember`) と揃える。
  // ここは外部 AI に送る材料を置く口なので、読むだけの人に開けない
  if (!["admin", "member"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const live = await getLive(session.user, id);
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return uploadSketchRef(request, liveSketchStore, session.user, live);
}

export async function DELETE(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "member"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const live = await getLive(session.user, id);
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return deleteSketchRef(request, liveSketchStore, session.user, live);
}
