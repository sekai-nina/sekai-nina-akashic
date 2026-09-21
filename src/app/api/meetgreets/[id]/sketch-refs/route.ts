import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getMeetGreet } from "@/lib/domain/meetgreets";
import { meetGreetSketchStore } from "@/lib/domain/meetgreet-sketch";
import { deleteSketchRef, uploadSketchRef } from "@/lib/meetgreet/sketch-ref-routes";

type Params = { params: Promise<{ id: string }> };

/** その回だけの参考画像 (#159)。処理本体は src/lib/meetgreet/sketch-ref-routes.ts (ライブと共用 #150) */
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
  const mg = await getMeetGreet(session.user, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return uploadSketchRef(request, meetGreetSketchStore, session.user, mg);
}

export async function DELETE(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "member"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const mg = await getMeetGreet(session.user, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return deleteSketchRef(request, meetGreetSketchStore, session.user, mg);
}
