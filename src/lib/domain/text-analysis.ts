import { prismaInternal } from "@/lib/db";
import { classificationFilterSql } from "@/lib/classification";
import { jstDayStart, jstDayEndExclusive } from "@/lib/utils";
import { Prisma } from "@prisma/client";

export interface AnalysisFilters {
  sourceType?: string;
  textTypes?: string[];
  personId?: string;
  tagIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  granularity?: "month" | "week";
}

export interface WordGroup {
  label: string;
  variants: string[];
}

function buildConditions(filters: AnalysisFilters, clearance: string): Prisma.Sql {
  // 生 SQL は prismaInternal (RLS バイパス) + classificationFilterSql の明示フィルタで絞る。
  // - 素の prisma だと app.clearance 未設定で RLS が全行を落とし、無言の 0 件になる
  // - withClearance で包むとインタラクティブトランザクションの 15 秒上限に当たる (実測 21 秒で P2028)
  // 集計が重いので、この組み合わせが正しい (CLAUDE.md の「生 SQL は classificationFilterSql を通す」)。
  const conditions: Prisma.Sql[] = [classificationFilterSql(clearance, "a")];

  if (filters.sourceType) {
    conditions.push(Prisma.sql`a."sourceType" = ${filters.sourceType}`);
  }

  if (filters.textTypes && filters.textTypes.length > 0) {
    conditions.push(
      Prisma.sql`t."textType"::text = ANY(${filters.textTypes})`
    );
  } else {
    conditions.push(
      Prisma.sql`t."textType" IN ('body', 'message_body')`
    );
  }

  // JST の暦日境界に直してから比較する。旧実装は UTC 0 時の値をそのまま使っており、
  // dateFrom 当日の JST 0〜9 時が落ち、dateTo は `<=` だったため**当日が丸ごと落ちていた**
  if (filters.dateFrom) {
    conditions.push(
      Prisma.sql`COALESCE(a."canonicalDate", a."createdAt") >= ${jstDayStart(new Date(filters.dateFrom))}`
    );
  }

  if (filters.dateTo) {
    conditions.push(
      Prisma.sql`COALESCE(a."canonicalDate", a."createdAt") < ${jstDayEndExclusive(new Date(filters.dateTo))}`
    );
  }

  if (filters.personId) {
    conditions.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "AssetEntity" ae
        WHERE ae."assetId" = a.id
          AND ae."entityId" = ${filters.personId}
      )`
    );
  }

  if (filters.tagIds && filters.tagIds.length > 0) {
    conditions.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "AssetEntity" ae
        WHERE ae."assetId" = a.id
          AND ae."entityId"::text = ANY(${filters.tagIds})
      )`
    );
  }

  return conditions.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
    : Prisma.empty;
}

/** Build SQL expression that sums occurrence counts for all variants */
function buildVariantCountExpr(variants: string[]): Prisma.Sql {
  const exprs = variants.map(
    (v) =>
      Prisma.sql`(LENGTH(t.content) - LENGTH(REPLACE(t.content, ${v}, ''))) / GREATEST(LENGTH(${v}), 1)`
  );
  return Prisma.sql`(${Prisma.join(exprs, " + ")})`;
}

/** Build SQL expression that checks if any variant appears in content */
function buildVariantMatchExpr(variants: string[]): Prisma.Sql {
  const checks = variants.map(
    (v) => Prisma.sql`POSITION(${v} IN t.content) > 0`
  );
  return Prisma.sql`(${Prisma.join(checks, " OR ")})`;
}

export async function getWordFrequencyOverTime(
  groups: WordGroup[],
  filters: AnalysisFilters,
  clearance: string
): Promise<{ points: Record<string, string | number>[]; labels: string[] }> {
  if (groups.length === 0) return { points: [], labels: [] };

  const where = buildConditions(filters, clearance);
  const trunc = filters.granularity === "week" ? "week" : "month";

  const results = await Promise.all(
    groups.map(async (group) => {
      const countExpr = buildVariantCountExpr(group.variants);
      const rows = await prismaInternal.$queryRaw<
        Array<{ bucket: Date; count: bigint }>
      >`
        SELECT
          date_trunc(${trunc}, COALESCE(a."canonicalDate", a."createdAt")) AS bucket,
          SUM(${countExpr})::bigint AS count
        FROM "AssetText" t
        JOIN "Asset" a ON a.id = t."assetId"
        ${where}
        GROUP BY bucket
        ORDER BY bucket
      `;
      return { label: group.label, rows };
    })
  );

  const allBuckets = new Set<string>();
  for (const { rows } of results) {
    for (const row of rows) {
      allBuckets.add(row.bucket.toISOString().slice(0, 10));
    }
  }

  const sortedBuckets = [...allBuckets].sort();
  const labels = groups.map((g) => g.label);
  const points = sortedBuckets.map((bucket) => {
    const point: Record<string, string | number> = { bucket };
    for (const { label, rows } of results) {
      const row = rows.find(
        (r) => r.bucket.toISOString().slice(0, 10) === bucket
      );
      point[label] = row ? Number(row.count) : 0;
    }
    return point;
  });

  return { points, labels };
}

export async function getWordAppearanceRate(
  groups: WordGroup[],
  filters: AnalysisFilters,
  clearance: string
): Promise<{ points: Record<string, string | number>[]; labels: string[] }> {
  if (groups.length === 0) return { points: [], labels: [] };

  const where = buildConditions(filters, clearance);
  const trunc = filters.granularity === "week" ? "week" : "month";

  const results = await Promise.all(
    groups.map(async (group) => {
      const matchExpr = buildVariantMatchExpr(group.variants);
      const rows = await prismaInternal.$queryRaw<
        Array<{
          bucket: Date;
          posts_with_word: bigint;
          total_posts: bigint;
        }>
      >`
        SELECT
          date_trunc(${trunc}, COALESCE(a."canonicalDate", a."createdAt")) AS bucket,
          COUNT(DISTINCT CASE WHEN ${matchExpr} THEN a.id END)::bigint AS posts_with_word,
          COUNT(DISTINCT a.id)::bigint AS total_posts
        FROM "AssetText" t
        JOIN "Asset" a ON a.id = t."assetId"
        ${where}
        GROUP BY bucket
        ORDER BY bucket
      `;
      return { label: group.label, rows };
    })
  );

  const allBuckets = new Set<string>();
  for (const { rows } of results) {
    for (const row of rows) {
      allBuckets.add(row.bucket.toISOString().slice(0, 10));
    }
  }

  const sortedBuckets = [...allBuckets].sort();
  const labels = groups.map((g) => g.label);
  const points = sortedBuckets.map((bucket) => {
    const point: Record<string, string | number> = { bucket };
    for (const { label, rows } of results) {
      const row = rows.find(
        (r) => r.bucket.toISOString().slice(0, 10) === bucket
      );
      if (row && Number(row.total_posts) > 0) {
        point[label] =
          Math.round(
            (Number(row.posts_with_word) / Number(row.total_posts)) * 1000
          ) / 10;
      } else {
        point[label] = 0;
      }
    }
    return point;
  });

  return { points, labels };
}

export async function getVolumeOverTime(
  filters: AnalysisFilters,
  clearance: string
): Promise<
  Array<{
    bucket: string;
    postCount: number;
    charCount: number;
    avgLength: number;
  }>
> {
  const where = buildConditions(filters, clearance);
  const trunc = filters.granularity === "week" ? "week" : "month";

  const rows = await prismaInternal.$queryRaw<
    Array<{
      bucket: Date;
      post_count: bigint;
      char_count: bigint;
      avg_length: number;
    }>
  >`
    SELECT
      date_trunc(${trunc}, COALESCE(a."canonicalDate", a."createdAt")) AS bucket,
      COUNT(DISTINCT a.id)::bigint AS post_count,
      SUM(LENGTH(t.content))::bigint AS char_count,
      AVG(LENGTH(t.content))::float AS avg_length
    FROM "AssetText" t
    JOIN "Asset" a ON a.id = t."assetId"
    ${where}
    GROUP BY bucket
    ORDER BY bucket
  `;

  return rows.map((row) => ({
    bucket: row.bucket.toISOString().slice(0, 10),
    postCount: Number(row.post_count),
    charCount: Number(row.char_count),
    avgLength: Math.round(row.avg_length ?? 0),
  }));
}
