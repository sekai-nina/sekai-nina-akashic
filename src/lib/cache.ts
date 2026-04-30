import { unstable_cache, revalidateTag } from "next/cache";
import { prisma } from "@/lib/db";
import { getDashboardStats } from "@/lib/domain/stats";

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

export const getCachedKindCounts = unstable_cache(
  () =>
    prisma.asset.groupBy({
      by: ["kind"],
      _count: true,
      orderBy: { _count: { kind: "desc" } },
    }),
  ["kind-counts"],
  { tags: [CACHE_TAGS.assets], revalidate: 60 }
);

export const getCachedStatusCounts = unstable_cache(
  () =>
    prisma.asset.groupBy({
      by: ["status"],
      _count: true,
    }),
  ["status-counts"],
  { tags: [CACHE_TAGS.assets], revalidate: 60 }
);

export const getCachedRecentAssets = unstable_cache(
  () =>
    prisma.asset.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { sourceRecords: { take: 1 } },
    }),
  ["recent-assets"],
  { tags: [CACHE_TAGS.assets], revalidate: 30 }
);

export const getCachedInboxCount = unstable_cache(
  () => prisma.asset.count({ where: { status: "inbox" } }),
  ["inbox-count"],
  { tags: [CACHE_TAGS.assets], revalidate: 30 }
);

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

export const getCachedAssetCount = unstable_cache(
  (where: Record<string, unknown>) => prisma.asset.count({ where }),
  ["asset-count"],
  { tags: [CACHE_TAGS.assets], revalidate: 30 }
);
