import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireApiAuth } from "@/lib/api-auth";
import { listFaceReviewFeed, REVIEW_FEED_DEFAULT_LIMIT, REVIEW_FEED_MAX_LIMIT } from "@/lib/domain/face-review";
import { parseFeedCursor } from "@/lib/domain/faces";

/**
 * 顔認識 (#441): Discord で 1 顔ずつ確認してもらう顔。`createdAfter` 以降に登録された画像の、この人物と推定された
 * 確認待ちの顔と、自動で付いた顔 (書き手が本人のものは除く)。登録の古い順。
 * GET /api/v1/faces/review-feed?entityId=<id>&createdAfter=<ISO8601>&limit=50[&after=<next>]
 * 満杯のページには `next` が付く。続きは `after=<next>` で取る (#446)
 */
export const dynamic = "force-dynamic";

/** 遡れる上限。全画像を舐めないように */
const MAX_LOOKBACK_MS = 14 * 24 * 3600 * 1000;

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const entityId = searchParams.get("entityId") ?? "";
  const createdAfter = new Date(searchParams.get("createdAfter") ?? "");
  const limit = Number(searchParams.get("limit") ?? REVIEW_FEED_DEFAULT_LIMIT);
  if (!entityId) return NextResponse.json({ error: "entityId は必須" }, { status: 400 });
  if (Number.isNaN(createdAfter.getTime())) {
    return NextResponse.json({ error: "createdAfter は ISO8601 の日時 (必須)" }, { status: 400 });
  }
  if (Date.now() - createdAfter.getTime() > MAX_LOOKBACK_MS) {
    return NextResponse.json({ error: "createdAfter は 14 日前まで" }, { status: 400 });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_FEED_MAX_LIMIT) {
    return NextResponse.json({ error: `limit は 1..${REVIEW_FEED_MAX_LIMIT}` }, { status: 400 });
  }
  // Entity は保護テーブルではない。人物でなければ 404
  const entity = await prisma.entity.findFirst({ where: { id: entityId, type: "person" }, select: { id: true } });
  if (!entity) return NextResponse.json({ error: "人物のエンティティが見つかりません" }, { status: 404 });

  const cursor = parseFeedCursor(searchParams.get("after"));
  if (cursor === "invalid") return NextResponse.json({ error: "after の形が違う" }, { status: 400 });

  const items = await listFaceReviewFeed(auth.clearance, entityId, createdAfter, cursor, limit);
  // 並びは画像の登録時刻・顔の ID なので、続きの位置もその 2 つ
  const last = items[items.length - 1];
  const next = items.length === limit && last ? `${last.createdAt}|${last.id}` : null;
  return NextResponse.json({ items, next }, { headers: { "Cache-Control": "no-store" } });
}
