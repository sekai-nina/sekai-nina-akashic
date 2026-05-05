import { prisma } from "@/lib/db";
import { GalleryGrid } from "./gallery-grid";

const PAGE_SIZE = 40;

export default async function GalleryPage() {
  const assets = await prisma.asset.findMany({
    where: {
      kind: { in: ["image", "video"] },
      thumbnailUrl: { not: null },
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
  });

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
      <GalleryGrid initialItems={items} initialCursor={nextCursor} />
    </div>
  );
}
