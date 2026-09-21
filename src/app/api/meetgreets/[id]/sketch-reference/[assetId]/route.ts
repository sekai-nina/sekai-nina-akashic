import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getMeetGreet } from "@/lib/domain/meetgreets";
import { serveSketchReference } from "@/lib/meetgreet/sketch-ref-routes";

type Params = { params: Promise<{ id: string; assetId: string }> };

/** 切り抜き枠を引くための画像 (#136)。処理本体は src/lib/meetgreet/sketch-ref-routes.ts (ライブと共用 #150) */
export const maxDuration = 60;

export async function GET(_request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, assetId } = await params;
  const mg = await getMeetGreet(session.user, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return serveSketchReference(session.user, mg, assetId);
}
