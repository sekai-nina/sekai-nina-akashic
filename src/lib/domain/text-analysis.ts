import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

export interface AnalysisFilters {
  sourceType?: string;
  textTypes?: string[];
  entityIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  granularity?: "month" | "week";
}

function buildConditions(filters: AnalysisFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];

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

  if (filters.dateFrom) {
    conditions.push(
      Prisma.sql`COALESCE(a."canonicalDate", a."createdAt") >= ${new Date(filters.dateFrom)}`
    );
  }

  if (filters.dateTo) {
    conditions.push(
      Prisma.sql`COALESCE(a."canonicalDate", a."createdAt") <= ${new Date(filters.dateTo)}`
    );
  }

  if (filters.entityIds && filters.entityIds.length > 0) {
    conditions.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "AssetEntity" ae
        WHERE ae."assetId" = a.id
          AND ae."entityId"::text = ANY(${filters.entityIds})
      )`
    );
  }

  return conditions.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
    : Prisma.empty;
}

export async function getWordFrequencyOverTime(
  words: string[],
  filters: AnalysisFilters
): Promise<{ points: Record<string, string | number>[]; words: string[] }> {
  if (words.length === 0) return { points: [], words: [] };

  const where = buildConditions(filters);
  const trunc = filters.granularity === "week" ? "week" : "month";

  const results = await Promise.all(
    words.map(async (word) => {
      const rows = await prisma.$queryRaw<
        Array<{ bucket: Date; count: bigint }>
      >`
        SELECT
          date_trunc(${trunc}, COALESCE(a."canonicalDate", a."createdAt")) AS bucket,
          SUM(
            (LENGTH(t.content) - LENGTH(REPLACE(t.content, ${word}, '')))
            / GREATEST(LENGTH(${word}), 1)
          )::bigint AS count
        FROM "AssetText" t
        JOIN "Asset" a ON a.id = t."assetId"
        ${where}
        GROUP BY bucket
        ORDER BY bucket
      `;
      return { word, rows };
    })
  );

  const allBuckets = new Set<string>();
  for (const { rows } of results) {
    for (const row of rows) {
      allBuckets.add(row.bucket.toISOString().slice(0, 10));
    }
  }

  const sortedBuckets = [...allBuckets].sort();
  const points = sortedBuckets.map((bucket) => {
    const point: Record<string, string | number> = { bucket };
    for (const { word, rows } of results) {
      const row = rows.find(
        (r) => r.bucket.toISOString().slice(0, 10) === bucket
      );
      point[word] = row ? Number(row.count) : 0;
    }
    return point;
  });

  return { points, words };
}

export async function getWordAppearanceRate(
  words: string[],
  filters: AnalysisFilters
): Promise<{ points: Record<string, string | number>[]; words: string[] }> {
  if (words.length === 0) return { points: [], words: [] };

  const where = buildConditions(filters);
  const trunc = filters.granularity === "week" ? "week" : "month";

  const results = await Promise.all(
    words.map(async (word) => {
      const rows = await prisma.$queryRaw<
        Array<{
          bucket: Date;
          posts_with_word: bigint;
          total_posts: bigint;
        }>
      >`
        SELECT
          date_trunc(${trunc}, COALESCE(a."canonicalDate", a."createdAt")) AS bucket,
          COUNT(DISTINCT CASE
            WHEN POSITION(${word} IN t.content) > 0 THEN a.id
          END)::bigint AS posts_with_word,
          COUNT(DISTINCT a.id)::bigint AS total_posts
        FROM "AssetText" t
        JOIN "Asset" a ON a.id = t."assetId"
        ${where}
        GROUP BY bucket
        ORDER BY bucket
      `;
      return { word, rows };
    })
  );

  const allBuckets = new Set<string>();
  for (const { rows } of results) {
    for (const row of rows) {
      allBuckets.add(row.bucket.toISOString().slice(0, 10));
    }
  }

  const sortedBuckets = [...allBuckets].sort();
  const points = sortedBuckets.map((bucket) => {
    const point: Record<string, string | number> = { bucket };
    for (const { word, rows } of results) {
      const row = rows.find(
        (r) => r.bucket.toISOString().slice(0, 10) === bucket
      );
      if (row && Number(row.total_posts) > 0) {
        point[word] =
          Math.round(
            (Number(row.posts_with_word) / Number(row.total_posts)) * 1000
          ) / 10;
      } else {
        point[word] = 0;
      }
    }
    return point;
  });

  return { points, words };
}

export async function getVolumeOverTime(
  filters: AnalysisFilters
): Promise<
  Array<{
    bucket: string;
    postCount: number;
    charCount: number;
    avgLength: number;
  }>
> {
  const where = buildConditions(filters);
  const trunc = filters.granularity === "week" ? "week" : "month";

  const rows = await prisma.$queryRaw<
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
