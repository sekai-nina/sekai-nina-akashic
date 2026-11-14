import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireApiAuth } from "@/lib/api-auth";
import {
  APPEARANCES_DEFAULT_LIMIT,
  APPEARANCES_MAX_LIMIT,
  listFaceAppearances,
  nextFeedCursor,
  parseFeedCursor,
} from "@/lib/domain/faces";

/**
 * 顔認識 (#395): この人物が写っている画像のうち、`createdAfter` 以降に登録されたもの。登録の古い順。
 * GET /api/v1/faces/appearances?entityId=<id>&createdAfter=<ISO8601>&limit=50[&after=<next>]
 * 満杯のページには `next` が付く。続きは `after=<next>` で取る (同じ登録時刻の画像が多くても進める。#446)
 * その人物が書き手 (author) の画像は除く。discord bot が他のメンバーのトーク・ブログに写っていたら流すのに使う
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
  const limit = Number(searchParams.get("limit") ?? APPEARANCES_DEFAULT_LIMIT);
  if (!entityId) return NextResponse.json({ error: "entityId は必須" }, { status: 400 });
  if (Number.isNaN(createdAfter.getTime())) {
    return NextResponse.json({ error: "createdAfter は ISO8601 の日時 (必須)" }, { status: 400 });
  }
  if (Date.now() - createdAfter.getTime() > MAX_LOOKBACK_MS) {
    return NextResponse.json({ error: "createdAfter は 14 日前まで" }, { status: 400 });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > APPEARANCES_MAX_LIMIT) {
    return NextResponse.json({ error: `limit は 1..${APPEARANCES_MAX_LIMIT}` }, { status: 400 });
  }
  // Entity は保護テーブルではない。人物でなければ 404 (タグや聖地の id で叩かせない)
  const entity = await prisma.entity.findFirst({ where: { id: entityId, type: "person" }, select: { id: true } });
  if (!entity) return NextResponse.json({ error: "人物のエンティティが見つかりません" }, { status: 404 });

  const cursor = parseFeedCursor(searchParams.get("after"));
  if (cursor === "invalid") return NextResponse.json({ error: "after の形が違う" }, { status: 400 });

  const items = await listFaceAppearances(auth.clearance, entityId, createdAfter, cursor, limit);
  return NextResponse.json({ items, next: nextFeedCursor(items, limit) }, { headers: { "Cache-Control": "no-store" } });
}
