import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listFaceReferenceChanges, listFaceReferences, REFERENCES_MAX_LIMIT } from "@/lib/domain/faces";
import { FACE_WORKER_PERMISSION } from "@/lib/faces/policy";

/**
 * 顔認識 (#384): 参照に足す顔 (人が確定した顔だけ)。推論ワーカーがアー写と合わせて使う。
 * - 全部: GET /api/v1/faces/references?after=<id>&limit=1000 — id の昇順。`next` が null になるまで続きを取る
 * - 差分 (#420): GET /api/v1/faces/references?updatedAfter=<ISO8601>&after=<next>&limit=1000 —
 *   その時刻より後に変わった、人が見た顔を `(updatedAt, id)` の昇順で。`entityId: null` は手本から外す顔
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

  const updatedAfterRaw = searchParams.get("updatedAfter");
  if (updatedAfterRaw) {
    const updatedAfter = new Date(updatedAfterRaw);
    if (Number.isNaN(updatedAfter.getTime())) {
      return NextResponse.json({ error: "updatedAfter は ISO8601 の日時" }, { status: 400 });
    }
    // 続きのカーソルは "<updatedAt の ISO8601>|<id>"
    let cursor: { updatedAt: Date; id: string } | null = null;
    if (after) {
      const [iso, id] = after.split("|");
      const at = new Date(iso);
      if (!id || Number.isNaN(at.getTime())) return NextResponse.json({ error: "after の形が違う" }, { status: 400 });
      cursor = { updatedAt: at, id };
    }
    const items = await listFaceReferenceChanges(auth.clearance, updatedAfter, cursor, limit);
    const last = items[items.length - 1];
    const next = items.length === limit && last ? `${last.updatedAt.toISOString()}|${last.id}` : null;
    return NextResponse.json({ items, next }, { headers: { "Cache-Control": "no-store" } });
  }

  const items = await listFaceReferences(auth.clearance, after, limit);
  const next = items.length === limit ? items[items.length - 1].id : null;
  return NextResponse.json({ items, next }, { headers: { "Cache-Control": "no-store" } });
}
