import { unstable_cache, revalidateTag } from "next/cache";
import { prismaInternal, withClearance } from "@/lib/db";
import { getDashboardStats } from "@/lib/domain/stats";
import { entityClearanceWhere } from "@/lib/domain/entities";
import { ClearanceLevel } from "@prisma/client";

// ========== Cache Tags ==========
export const CACHE_TAGS = {
  assets: "assets",
  entities: "entities",
  dossiers: "dossiers",
  stats: "stats",
  places: "places",
} as const;

export function invalidateAssets() {
  revalidateTag(CACHE_TAGS.assets, "max");
  revalidateTag(CACHE_TAGS.stats, "max");
}

export function invalidateEntities() {
  revalidateTag(CACHE_TAGS.entities, "max");
}

export function invalidatePlaces() {
  revalidateTag(CACHE_TAGS.places, "max");
  revalidateTag(CACHE_TAGS.entities, "max");
}

export function invalidateDossiers() {
  revalidateTag(CACHE_TAGS.dossiers, "max");
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

// Entity には実質的な RLS が無いため、クリアランスで見えない聖地エンティティを
// アプリ層で落とす (詳細は entityClearanceWhere の JSDoc)。キャッシュキーは
// クリアランス別にする — getCachedPlaces と同じ方式。
export const getCachedEntities = (clearance: ClearanceLevel) =>
  unstable_cache(
    () =>
      withClearance(clearance, (tx) =>
        tx.entity.findMany({
          where: entityClearanceWhere(clearance),
          include: { _count: { select: { assets: true } } },
          orderBy: [{ type: "asc" }, { canonicalName: "asc" }],
        })
      ),
    [`entities-list-${clearance}`],
    { tags: [CACHE_TAGS.entities], revalidate: 60 }
  )();

/** Lightweight entity list (no _count) for search/filter forms */
export const getCachedEntityList = (clearance: ClearanceLevel) =>
  unstable_cache(
    () =>
      withClearance(clearance, (tx) =>
        tx.entity.findMany({
          where: entityClearanceWhere(clearance),
          select: {
            id: true,
            type: true,
            canonicalName: true,
            normalizedName: true,
            generation: true,
            reading: true,
          },
          orderBy: [{ type: "asc" }, { canonicalName: "asc" }],
        })
      ),
    [`entities-list-light-${clearance}`],
    { tags: [CACHE_TAGS.entities], revalidate: 300 }
  )();

export const getCachedEntityById = (id: string, clearance: ClearanceLevel) =>
  unstable_cache(
    () =>
      withClearance(clearance, (tx) =>
        tx.entity.findFirst({
          where: { AND: [{ id }, entityClearanceWhere(clearance)] },
          include: { _count: { select: { assets: true } } },
        })
      ),
    [`entity-detail-${clearance}-${id}`],
    { tags: [CACHE_TAGS.entities], revalidate: 60 }
  )();

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
    // 「直近7日」は公開/放送日(canonicalDate)基準。createdAtだと一括インポート時刻を拾い実態と乖離する。
    const [blogPosts, talkMessages, media, lives] = await Promise.all([
      prismaInternal.asset.count({
        where: { sourceType: "web", kind: "text", canonicalDate: { gte: since }, entities: { some: { entityId: ninaEntityId } } },
      }),
      prismaInternal.asset.count({
        where: { sourceType: "import", kind: "text", canonicalDate: { gte: since }, entities: { some: { entityId: ninaEntityId } } },
      }),
      prismaInternal.assetEntity.count({
        where: {
          asset: { canonicalDate: { gte: since } },
          entity: { type: "tag", canonicalName: { in: ["日向坂で会いましょう", "まだまだ！日向坂で会いましょう", "日向坂になりましょう", "日向坂ちゃんねる", "日向坂46公式チャンネル", "雑誌"] } },
        },
      }),
      // 他の 3 本と同じく prismaInternal を使う (全体統計なので RLS バイパスが正)。
      // 素の prisma だと app.clearance 未設定で無言の 0 件になる
      prismaInternal.assetEntity.count({
        where: {
          asset: { canonicalDate: { gte: since } },
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

export const getCachedPlaces = (clearance: ClearanceLevel) => {
  const clearanceOrder: ClearanceLevel[] = ["public", "internal", "confidential", "restricted"];
  const maxLevel = clearanceOrder.indexOf(clearance);
  const allowedLevels = clearanceOrder.slice(0, maxLevel + 1);

  return unstable_cache(
    () =>
      withClearance(clearance, (tx) =>
        tx.place.findMany({
          where: {
            status: "confirmed",
            classification: { in: allowedLevels.length > 0 ? allowedLevels : ["public"] },
          },
          include: {
            entity: {
              include: { _count: { select: { assets: true } } },
            },
          },
          orderBy: { entity: { canonicalName: "asc" } },
        })
      ),
    [`places-list-${clearance}`],
    { tags: [CACHE_TAGS.places], revalidate: 60 }
  )();
};
