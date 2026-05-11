import { unstable_cache, revalidateTag } from "next/cache";
import { prisma, prismaInternal, withClearance } from "@/lib/db";
import { getDashboardStats } from "@/lib/domain/stats";
import { ClearanceLevel } from "@prisma/client";

// ========== Cache Tags ==========
export const CACHE_TAGS = {
  assets: "assets",
  entities: "entities",
  collections: "collections",
  stats: "stats",
} as const;

export function invalidateAssets() {
  revalidateTag(CACHE_TAGS.assets, "max");
  revalidateTag(CACHE_TAGS.stats, "max");
}

export function invalidateEntities() {
  revalidateTag(CACHE_TAGS.entities, "max");
}

export function invalidateCollections() {
  revalidateTag(CACHE_TAGS.collections, "max");
}

// ========== Cached Queries ==========

export const getCachedDashboardStats = unstable_cache(
  () => getDashboardStats(),
  ["dashboard-stats"],
  { tags: [CACHE_TAGS.stats], revalidate: 60 }
);

export const getCachedKindCounts = (clearance: ClearanceLevel) =>
  unstable_cache(
    () =>
      withClearance(clearance, (tx) =>
        tx.asset.groupBy({
          by: ["kind"],
          _count: true,
          orderBy: { _count: { kind: "desc" } },
        })
      ),
    [`kind-counts-${clearance}`],
    { tags: [CACHE_TAGS.assets], revalidate: 60 }
  )();

export const getCachedStatusCounts = (clearance: ClearanceLevel) =>
  unstable_cache(
    () =>
      withClearance(clearance, (tx) =>
        tx.asset.groupBy({
          by: ["status"],
          _count: true,
        })
      ),
    [`status-counts-${clearance}`],
    { tags: [CACHE_TAGS.assets], revalidate: 60 }
  )();

export const getCachedRecentAssets = (clearance: ClearanceLevel) =>
  unstable_cache(
    () =>
      withClearance(clearance, (tx) =>
        tx.asset.findMany({
          orderBy: { createdAt: "desc" },
          take: 8,
          include: { sourceRecords: { take: 1 } },
        })
      ),
    [`recent-assets-${clearance}`],
    { tags: [CACHE_TAGS.assets], revalidate: 30 }
  )();

export const getCachedInboxCount = (clearance: ClearanceLevel) =>
  unstable_cache(
    () =>
      withClearance(clearance, (tx) =>
        tx.asset.count({ where: { status: "inbox" } })
      ),
    [`inbox-count-${clearance}`],
    { tags: [CACHE_TAGS.assets], revalidate: 30 }
  )();

export const getCachedEntities = unstable_cache(
  () =>
    prisma.entity.findMany({
      include: { _count: { select: { assets: true } } },
      orderBy: [{ type: "asc" }, { canonicalName: "asc" }],
    }),
  ["entities-list"],
  { tags: [CACHE_TAGS.entities], revalidate: 60 }
);

export const getCachedEntityById = unstable_cache(
  (id: string) =>
    prisma.entity.findUnique({
      where: { id },
      include: { _count: { select: { assets: true } } },
    }),
  ["entity-detail"],
  { tags: [CACHE_TAGS.entities], revalidate: 60 }
);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const getCachedKindCountsRecent = (clearance: ClearanceLevel) =>
  unstable_cache(
    () => {
      const since = new Date(Date.now() - SEVEN_DAYS_MS);
      return withClearance(clearance, (tx) =>
        tx.asset.groupBy({
          by: ["kind"],
          where: { createdAt: { gte: since } },
          _count: true,
        })
      );
    },
    [`kind-counts-recent-${clearance}`],
    { tags: [CACHE_TAGS.assets], revalidate: 60 }
  )();

export const getCachedNinaStatsRecent = unstable_cache(
  async () => {
    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    const ninaEntityId = "cmmtp8vrg0004mo381neyztvn";
    const [blogPosts, talkMessages, media, lives] = await Promise.all([
      prismaInternal.asset.count({
        where: { sourceType: "web", kind: "text", createdAt: { gte: since }, entities: { some: { entityId: ninaEntityId } } },
      }),
      prismaInternal.asset.count({
        where: { sourceType: "import", kind: "text", createdAt: { gte: since } },
      }),
      prismaInternal.assetEntity.count({
        where: {
          createdAt: { gte: since },
          entity: { type: "tag", canonicalName: { in: ["日向坂で会いましょう", "日向坂になりましょう", "日向坂ちゃんねる", "日向坂46公式チャンネル", "雑誌"] } },
        },
      }),
      prisma.assetEntity.count({
        where: {
          createdAt: { gte: since },
          entity: { type: "tag", canonicalName: "ライブ" },
        },
      }),
    ]);
    return { blogPosts, talkMessages, media, lives };
  },
  ["nina-stats-recent"],
  { tags: [CACHE_TAGS.stats], revalidate: 60 }
);

export const getCachedAssetCount = (clearance: ClearanceLevel) =>
  unstable_cache(
    (where: Record<string, unknown>) =>
      withClearance(clearance, (tx) =>
        tx.asset.count({ where })
      ),
    [`asset-count-${clearance}`],
    { tags: [CACHE_TAGS.assets], revalidate: 30 }
  );
