import { unstable_cache, revalidateTag, updateTag } from "next/cache";
import { prismaInternal, withClearance } from "@/lib/db";
import { getDashboardStats } from "@/lib/domain/stats";
import { entityClearanceWhere } from "@/lib/domain/entities";
import { ClearanceLevel, Prisma } from "@prisma/client";
import { accessibleClassifications, classificationFilterSql } from "@/lib/classification";

// ========== Cache Tags ==========
export const CACHE_TAGS = {
  assets: "assets",
  entities: "entities",
  dossiers: "dossiers",
  stats: "stats",
  places: "places",
  anniversaries: "anniversaries",
  announcements: "announcements",
} as const;

export function invalidateAssets() {
  revalidateTag(CACHE_TAGS.assets, "max");
  revalidateTag(CACHE_TAGS.stats, "max");
}

/**
 * 一覧系だけを飛ばす。統計 (stats) は据え置く。
 *
 * stats タグの getCachedDashboardStats / getCachedNinaStatsRecent はどちらも
 * revalidate 60 秒なので放っておいても 1 分で更新される。一方 getDashboardStats は
 * Asset 12 万件に対する 16 本のサブクエリなので、外部 bot が 1 件ずつ POST する
 * たびに飛ばすと、次にダッシュボードを開いた人が毎回その再計算を待つことになる。
 *
 * 人間が画面から操作したとき (actions.ts / quick-create) は即座に反映されてほしいので
 * invalidateAssets を使う。外部からの取り込みはこちら。
 */
export function invalidateAssetList() {
  revalidateTag(CACHE_TAGS.assets, "max");
}

export function invalidateEntities() {
  revalidateTag(CACHE_TAGS.entities, "max");
}

/**
 * Server Action 内で使う即時版。"max" の stale-while-revalidate だと保存直後の再描画に
 * 古い値が出て、保存に失敗したように見える箇所に使う。
 */
export function expireEntities() {
  updateTag(CACHE_TAGS.entities);
}

export function invalidatePlaces() {
  revalidateTag(CACHE_TAGS.places, "max");
  revalidateTag(CACHE_TAGS.entities, "max");
}

export function invalidateAnniversaries() {
  revalidateTag(CACHE_TAGS.anniversaries, "max");
}

export function invalidateAnnouncements() {
  revalidateTag(CACHE_TAGS.announcements, "max");
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

// サイドバーの「クリップ」バッジ (#41)。プールは viewMode = clearance なので
// app.user_id 無し (withClearance) でも RLS が通る。見えないクリアランスでは 0 になる
export const getCachedClipCount = (clearance: ClearanceLevel) =>
  unstable_cache(
    () =>
      withClearance(clearance, (tx) =>
        tx.dossierItem.count({ where: { dossier: { kind: "clips" } } })
      ),
    [`clip-count-${clearance}`],
    { tags: [CACHE_TAGS.dossiers], revalidate: 30 }
  )();

/**
 * エンティティごとの紐づきアセット数 (そのクリアランスで見える分)。`{ [entityId]: 件数 }`
 *
 * `_count: { assets }` は AssetEntity (約 37 万行) の 1 行ずつに RLS (親 Asset の区分) を当てるので、
 * 全エンティティ分で本番 4〜12 秒かかっていた。RLS をバイパスし、区分で明示的に絞ってまとめて数える
 * (CLAUDE.md「生 SQL・重い集計は prismaInternal + classificationFilterSql」)。
 * それでも 0.5 秒以上かかるので、表示用の件数として 10 分のずれは許してキャッシュする
 * (アセットの区分を上げた直後は、下のクリアランスにも上げる前の件数が最長 10 分見える。件数だけで中身は出ない)
 */
export const getCachedEntityAssetCounts = (clearance: ClearanceLevel) =>
  unstable_cache(
    async () => {
      // 未知のクリアランスでは何も見せない (`IN ()` は構文エラーになるので先に返す)
      if (accessibleClassifications(clearance).length === 0) return {} as Record<string, number>;
      const rows = await prismaInternal.$queryRaw<{ entityId: string; n: bigint }[]>(Prisma.sql`
        SELECT ae."entityId", count(*) AS n
        FROM "AssetEntity" ae JOIN "Asset" a ON a.id = ae."assetId"
        WHERE ${classificationFilterSql(clearance)}
        GROUP BY ae."entityId"`);
      return Object.fromEntries(rows.map((r) => [r.entityId, Number(r.n)])) as Record<string, number>;
    },
    [`entity-asset-counts-${clearance}`],
    { tags: [CACHE_TAGS.assets, CACHE_TAGS.entities], revalidate: 600 }
  )();

/** `_count.assets` を getCachedEntityAssetCounts の件数で埋める (呼び出し側の形を変えないため) */
export function withAssetCount<T extends { id: string }>(entity: T, counts: Record<string, number>) {
  return { ...entity, _count: { assets: counts[entity.id] ?? 0 } };
}

// Entity には実質的な RLS が無いため、クリアランスで見えない聖地エンティティを
// アプリ層で落とす (詳細は entityClearanceWhere の JSDoc)。キャッシュキーは
// クリアランス別にする — getCachedPlaces と同じ方式。
export const getCachedEntities = async (clearance: ClearanceLevel) => {
  const [entities, counts] = await Promise.all([
    unstable_cache(
      () =>
        withClearance(clearance, (tx) =>
          tx.entity.findMany({
            where: entityClearanceWhere(clearance),
            orderBy: [{ type: "asc" }, { canonicalName: "asc" }],
          })
        ),
      // アセット数を別に引くようにしたので鍵を変える (Vercel のデータキャッシュはデプロイをまたいで残る)
      [`entities-list-v3-${clearance}`],
      { tags: [CACHE_TAGS.entities], revalidate: 60 }
    )(),
    getCachedEntityAssetCounts(clearance),
  ]);
  return entities.map((e) => withAssetCount(e, counts));
};

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
            tagGroup: true,
          },
          orderBy: [{ type: "asc" }, { canonicalName: "asc" }],
        })
      ),
    // tagGroup を足したので鍵を変える (Vercel のデータキャッシュはデプロイをまたいで残る)
    [`entities-list-light-v2-${clearance}`],
    { tags: [CACHE_TAGS.entities], revalidate: 300 }
  )();

export const getCachedEntityById = async (id: string, clearance: ClearanceLevel) => {
  const [entity, counts] = await Promise.all([
    unstable_cache(
      () =>
        withClearance(clearance, (tx) =>
          tx.entity.findFirst({
            where: { AND: [{ id }, entityClearanceWhere(clearance)] },
          })
        ),
      // アセット数を別に引くようにしたので鍵を変える (坂井新奈は 7.8 万件あり、1 件でも数えるのが重い)
      [`entity-detail-v3-${clearance}-${id}`],
      { tags: [CACHE_TAGS.entities], revalidate: 60 }
    )(),
    getCachedEntityAssetCounts(clearance),
  ]);
  return entity ? withAssetCount(entity, counts) : null;
};

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
          entity: { type: "tag", canonicalName: { in: ["日向坂で会いましょう", "まだまだ！日向坂で会いましょう", "日向坂になりましょう", "日向坂ちゃんねる", "日向坂46公式チャンネル", "雑誌", "外番組"] } },
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

  return Promise.all([
    unstable_cache(
      () =>
        withClearance(clearance, (tx) =>
          tx.place.findMany({
            where: {
              status: "confirmed",
              classification: { in: allowedLevels.length > 0 ? allowedLevels : ["public"] },
            },
            include: {
              entity: true,
              // 地図の「訪問した記事」とルート表示に使う
              articles: {
                orderBy: { sortOrder: "asc" },
                select: {
                  sortOrder: true,
                  certainty: true,
                  certaintyNote: true,
                  article: { select: { shortId: true, title: true, date: true, dateDisplay: true, draft: true } },
                },
              },
            },
            // 新しく登録した聖地を上に
            orderBy: { createdAt: "desc" },
          })
        ),
      // 記事を含めるようにしたので鍵を変える (Vercel のデータキャッシュはデプロイをまたいで残る)
      // 訪問の確度 (#333) を足したので v5
      [`places-list-v5-${clearance}`],
      { tags: [CACHE_TAGS.places], revalidate: 60 }
    )(),
    getCachedEntityAssetCounts(clearance),
  ]).then(([places, counts]) => places.map((p) => ({ ...p, entity: withAssetCount(p.entity, counts) })));
};
