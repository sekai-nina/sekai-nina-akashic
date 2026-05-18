import { auth } from "@/lib/auth";
import { withClearance } from "@/lib/db";
import { NextResponse } from "next/server";

const PAGE_SIZE = 40;

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const entityIdsParam =
    url.searchParams.get("entityIds") ?? url.searchParams.get("entityId");
  const entityIds = entityIdsParam
    ? entityIdsParam.split(",").filter(Boolean)
    : [];
  const kindParam = url.searchParams.get("kind");

  const where: Record<string, unknown> = {
    thumbnailUrl: { not: null },
  };

  if (kindParam === "image" || kindParam === "video") {
    where.kind = kindParam;
  } else {
    where.kind = { in: ["image", "video"] };
  }

  if (entityIds.length > 0) {
    where.AND = entityIds.map((id) => ({
      entities: { some: { entityId: id } },
    }));
  }

  const assets = await withClearance(session.user.clearance, (tx) =>
    tx.asset.findMany({
      where,
      orderBy: [
        { canonicalDate: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        kind: true,
        thumbnailUrl: true,
        storageKey: true,
        storageProvider: true,
        canonicalDate: true,
        createdAt: true,
      },
    })
  );

  const hasMore = assets.length > PAGE_SIZE;
  const items = assets.slice(0, PAGE_SIZE);
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return NextResponse.json({ items, nextCursor });
}
