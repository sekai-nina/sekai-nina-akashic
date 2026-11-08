import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listFaceReferences, REFERENCES_MAX_LIMIT } from "@/lib/domain/faces";
import { FACE_WORKER_PERMISSION } from "@/lib/faces/policy";

/**
 * 顔認識 (#384): 参照に足す顔 (人が確定した顔だけ)。推論ワーカーがアー写と合わせて使う。
 * GET /api/v1/faces/references?after=<id>&limit=1000 — id の昇順。`next` が null になるまで続きを取る
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, FACE_WORKER_PERMISSION);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const after = searchParams.get("after") || undefined;
  const limit = Number(searchParams.get("limit") ?? REFERENCES_MAX_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > REFERENCES_MAX_LIMIT) {
    return NextResponse.json({ error: `limit は 1..${REFERENCES_MAX_LIMIT}` }, { status: 400 });
  }

  const items = await listFaceReferences(auth.clearance, after, limit);
  const next = items.length === limit ? items[items.length - 1].id : null;
  return NextResponse.json({ items, next }, { headers: { "Cache-Control": "no-store" } });
}
