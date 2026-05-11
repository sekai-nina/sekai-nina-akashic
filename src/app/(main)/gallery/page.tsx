import { withClearance } from "@/lib/db";
import { auth } from "@/lib/auth";
import { GalleryGrid } from "./gallery-grid";

const PAGE_SIZE = 40;
const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

export default async function GalleryPage() {
  const session = await auth();

  const assets = await withClearance(session!.user.clearance, (tx) =>
    tx.asset.findMany({
      where: {
        kind: { in: ["image", "video"] },
        thumbnailUrl: { not: null },
        entities: { some: { entityId: NINA_ENTITY_ID } },
      },
      orderBy: [
        { canonicalDate: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      take: PAGE_SIZE + 1,
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
  const items = assets.slice(0, PAGE_SIZE).map((a) => ({
    ...a,
    canonicalDate: a.canonicalDate?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  }));
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">ギャラリー</h1>
      </div>
      <GalleryGrid initialItems={items} initialCursor={nextCursor} entityId={NINA_ENTITY_ID} />
    </div>
  );
}
