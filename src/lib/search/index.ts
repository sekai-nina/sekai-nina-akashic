import { prisma } from "@/lib/db";
import { normalizeText } from "@/lib/utils";
import { Prisma, AssetKind, AssetStatus, TrustLevel, SourceType } from "@prisma/client";

export interface SearchQuery {
  q: string;
  target?: "all" | "assets" | "texts";
  kind?: AssetKind;
  status?: AssetStatus;
  trustLevel?: TrustLevel;
  sourceType?: SourceType;
  entityId?: string;
  entityIds?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  perPage?: number;
}

export interface SearchResultItem {
  type: "asset" | "text";
  assetId: string;
  assetTitle: string;
  assetKind: AssetKind;
  assetStatus: AssetStatus;
  thumbnailUrl: string | null;
  storageUrl: string | null;
  snippets: string[];
  matchField: string;
  score: number;
  createdAt: Date;
  canonicalDate: Date | null;
  personNames: string[];
}

/** Drive の直リンクをプロキシURLに変換する */
function resolveImageUrl(
  thumbnailUrl: string | null,
  storageProvider: string | null,
  storageKey: string | null,
  kind: string
): string | null {
  if (kind === "image" && storageProvider === "gdrive" && storageKey) {
    return `/api/drive-image/${storageKey}`;
  }
  return thumbnailUrl;
}

export interface SearchResult {
  items: SearchResultItem[];
  total: number;
  page: number;
  perPage: number;
}

/**
 * Find all occurrences of query terms in text and return snippets.
 * Nearby occurrences are merged into a single snippet.
 */
function buildSnippets(text: string, query: string, contextLen = 80): string[] {
  const terms = query.split("|").map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return [text.slice(0, contextLen * 2) + (text.length > contextLen * 2 ? "…" : "")];

  const lower = text.toLowerCase();

  // Find all match positions
  const positions: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    const termLower = term.toLowerCase();
    let cursor = 0;
    while (cursor < lower.length) {
      const idx = lower.indexOf(termLower, cursor);
      if (idx === -1) break;
      positions.push({ start: idx, end: idx + term.length });
      cursor = idx + term.length;
    }
  }

  if (positions.length === 0) {
    return [text.slice(0, contextLen * 2) + (text.length > contextLen * 2 ? "…" : "")];
  }

  // Sort by position
  positions.sort((a, b) => a.start - b.start);

  // Merge nearby positions into context ranges
  const ranges: Array<{ start: number; end: number }> = [];
  for (const pos of positions) {
    const ctxStart = Math.max(0, pos.start - contextLen);
    const ctxEnd = Math.min(text.length, pos.end + contextLen);
    if (ranges.length > 0 && ctxStart <= ranges[ranges.length - 1].end) {
      ranges[ranges.length - 1].end = Math.max(
        ranges[ranges.length - 1].end,
        ctxEnd
      );
    } else {
      ranges.push({ start: ctxStart, end: ctxEnd });
    }
  }

  return ranges.map((range) => {
    let snippet = "";
    if (range.start > 0) snippet += "…";
    snippet += text.slice(range.start, range.end);
    if (range.end < text.length) snippet += "…";
    return snippet;
  });
}

/** Fetch person entity names for a list of asset IDs */
async function getPersonNames(
  assetIds: string[]
): Promise<Map<string, string[]>> {
  if (assetIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<
    Array<{ assetId: string; name: string }>
  >`
    SELECT ae."assetId", e."canonicalName" as name
    FROM "AssetEntity" ae
    JOIN "Entity" e ON e.id = ae."entityId"
    WHERE ae."assetId"::text = ANY(${assetIds})
      AND e.type = 'person'
  `;
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const names = map.get(row.assetId) ?? [];
    names.push(row.name);
    map.set(row.assetId, names);
  }
  return map;
}

export async function search(query: SearchQuery): Promise<SearchResult> {
  const { q, target = "all", page = 1, perPage = 20 } = query;
  const offset = (page - 1) * perPage;
  const hasKeyword = q.trim().length > 0;

  // Support OR search with | separator
  const terms = hasKeyword
    ? q.split("|").map((t) => t.trim()).filter(Boolean)
    : [];
  const normalizedTerms = terms.map((t) => normalizeText(t));
  const likePatterns = terms.map((t) => `%${t}%`);
  const normalizedLikePatterns = normalizedTerms.map((t) => `%${t}%`);

  const results: SearchResultItem[] = [];

  const assetWhereConditions: Prisma.Sql[] = [];

  // Base filters
  if (query.kind) assetWhereConditions.push(Prisma.sql`a."kind" = ${query.kind}::"AssetKind"`);
  if (query.status) assetWhereConditions.push(Prisma.sql`a."status" = ${query.status}::"AssetStatus"`);
  if (query.trustLevel) assetWhereConditions.push(Prisma.sql`a."trustLevel" = ${query.trustLevel}::"TrustLevel"`);
  if (query.sourceType) assetWhereConditions.push(Prisma.sql`a."sourceType" = ${query.sourceType}::"SourceType"`);
  if (query.dateFrom) assetWhereConditions.push(Prisma.sql`a."canonicalDate" >= ${query.dateFrom}`);
  if (query.dateTo) assetWhereConditions.push(Prisma.sql`a."canonicalDate" <= ${query.dateTo}`);

  const baseFilter = assetWhereConditions.length > 0
    ? Prisma.sql`AND ${Prisma.join(assetWhereConditions, " AND ")}`
    : Prisma.empty;

  // Entity filter as subquery (supports multiple entityIds with AND logic)
  const allEntityIds = [
    ...(query.entityId ? [query.entityId] : []),
    ...(query.entityIds ?? []),
  ];
  const entityFilter = allEntityIds.length > 0
    ? Prisma.sql`${Prisma.join(
        allEntityIds.map(
          (eid) =>
            Prisma.sql`AND EXISTS (SELECT 1 FROM "AssetEntity" ae WHERE ae."assetId" = a."id" AND ae."entityId" = ${eid})`
        ),
        " "
      )}`
    : Prisma.empty;

  // キーワードなし＋フィルタもなし → 空結果
  const hasFilters = assetWhereConditions.length > 0 || allEntityIds.length > 0;
  if (!hasKeyword && !hasFilters) {
    return { items: [], total: 0, page, perPage };
  }

  // Search assets directly
  if (target === "all" || target === "assets") {
    const keywordCondition = hasKeyword
      ? Prisma.sql`(${Prisma.join(
          likePatterns.map(
            (pat) => Prisma.sql`a."title" ILIKE ${pat} OR a."description" ILIKE ${pat} OR a."messageBodyPreview" ILIKE ${pat}`
          ),
          " OR "
        )})`
      : Prisma.sql`TRUE`;

    const assetResults = await prisma.$queryRaw<Array<{
      id: string;
      title: string;
      description: string;
      kind: AssetKind;
      status: AssetStatus;
      thumbnailUrl: string | null;
      storageUrl: string | null;
      storageProvider: string | null;
      storageKey: string | null;
      messageBodyPreview: string | null;
      createdAt: Date;
      canonicalDate: Date | null;
    }>>`
      SELECT
        a."id", a."title", a."description", a."kind", a."status",
        a."thumbnailUrl", a."storageUrl", a."storageProvider", a."storageKey",
        a."messageBodyPreview", a."createdAt", a."canonicalDate"
      FROM "Asset" a
      WHERE ${keywordCondition}
      ${baseFilter}
      ${entityFilter}
      ORDER BY a."createdAt" DESC
      LIMIT ${perPage} OFFSET ${offset}
    `;

    for (const row of assetResults) {
      const termsLower = terms.map((t) => t.toLowerCase());
      const titleMatch = hasKeyword && termsLower.some((t) => row.title.toLowerCase().includes(t));
      const descMatch = hasKeyword && termsLower.some((t) => row.description.toLowerCase().includes(t));
      const previewMatch = hasKeyword && termsLower.some((t) => (row.messageBodyPreview || "").toLowerCase().includes(t));
      const matchField = titleMatch ? "title" : descMatch ? "description" : previewMatch ? "messageBodyPreview" : "title";
      const matchText = titleMatch ? row.title : descMatch ? row.description : previewMatch ? (row.messageBodyPreview || "") : row.title;
      results.push({
        type: "asset",
        assetId: row.id,
        assetTitle: row.title || "(無題)",
        assetKind: row.kind,
        assetStatus: row.status,
        thumbnailUrl: resolveImageUrl(row.thumbnailUrl, row.storageProvider, row.storageKey, row.kind),
        storageUrl: row.storageUrl,
        snippets: hasKeyword ? buildSnippets(matchText, q) : [row.title],
        matchField,
        score: titleMatch ? 3 : descMatch ? 2 : previewMatch ? 1 : 0,
        createdAt: row.createdAt,
        canonicalDate: row.canonicalDate,
        personNames: [],
      });
    }
  }

  // Search AssetTexts (only when keyword is provided)
  if (hasKeyword && (target === "all" || target === "texts")) {
    const textResults = await prisma.$queryRaw<Array<{
      id: string;
      assetId: string;
      textType: string;
      content: string;
      asset_title: string;
      asset_kind: AssetKind;
      asset_status: AssetStatus;
      asset_thumbnailUrl: string | null;
      asset_storageUrl: string | null;
      asset_storageProvider: string | null;
      asset_storageKey: string | null;
      asset_createdAt: Date;
      asset_canonicalDate: Date | null;
    }>>`
      SELECT
        t."id", t."assetId", t."textType", t."content",
        a."title" as asset_title, a."kind" as asset_kind, a."status" as asset_status,
        a."thumbnailUrl" as "asset_thumbnailUrl", a."storageUrl" as "asset_storageUrl",
        a."storageProvider" as "asset_storageProvider", a."storageKey" as "asset_storageKey",
        a."createdAt" as "asset_createdAt", a."canonicalDate" as "asset_canonicalDate"
      FROM "AssetText" t
      JOIN "Asset" a ON a."id" = t."assetId"
      WHERE (${Prisma.join(
          likePatterns.flatMap((pat, i) => [
            Prisma.sql`t."content" ILIKE ${pat}`,
            Prisma.sql`t."normalizedContent" ILIKE ${normalizedLikePatterns[i]}`,
          ]),
          " OR "
        )})
      ${baseFilter}
      ${entityFilter}
      ORDER BY a."createdAt" DESC
      LIMIT ${perPage} OFFSET ${offset}
    `;

    for (const row of textResults) {
      results.push({
        type: "text",
        assetId: row.assetId,
        assetTitle: row.asset_title || "(無題)",
        assetKind: row.asset_kind,
        assetStatus: row.asset_status,
        thumbnailUrl: resolveImageUrl(row.asset_thumbnailUrl, row.asset_storageProvider, row.asset_storageKey, row.asset_kind),
        storageUrl: row.asset_storageUrl,
        snippets: buildSnippets(row.content, q),
        matchField: row.textType,
        score: 1,
        createdAt: row.asset_createdAt,
        canonicalDate: row.asset_canonicalDate,
        personNames: [],
      });
    }
  }

  // Search Entity matches → return linked assets (only when keyword is provided)
  if (hasKeyword && (target === "all" || target === "assets")) {
    const entityAssets = await prisma.$queryRaw<Array<{
      assetId: string;
      asset_title: string;
      asset_kind: AssetKind;
      asset_status: AssetStatus;
      asset_thumbnailUrl: string | null;
      asset_storageUrl: string | null;
      asset_storageProvider: string | null;
      asset_storageKey: string | null;
      asset_createdAt: Date;
      asset_canonicalDate: Date | null;
      entity_name: string;
    }>>`
      SELECT DISTINCT ON (ae."assetId")
        ae."assetId",
        a."title" as asset_title, a."kind" as asset_kind, a."status" as asset_status,
        a."thumbnailUrl" as "asset_thumbnailUrl", a."storageUrl" as "asset_storageUrl",
        a."storageProvider" as "asset_storageProvider", a."storageKey" as "asset_storageKey",
        a."createdAt" as "asset_createdAt", a."canonicalDate" as "asset_canonicalDate",
        e."canonicalName" as entity_name
      FROM "Entity" e
      JOIN "AssetEntity" ae ON ae."entityId" = e."id"
      JOIN "Asset" a ON a."id" = ae."assetId"
      WHERE (${Prisma.join(
          likePatterns.flatMap((pat, i) => [
            Prisma.sql`e."canonicalName" ILIKE ${pat}`,
            Prisma.sql`e."normalizedName" ILIKE ${normalizedLikePatterns[i]}`,
          ]),
          " OR "
        )})
      ${baseFilter}
      ORDER BY ae."assetId", a."createdAt" DESC
      LIMIT ${perPage}
    `;

    for (const row of entityAssets) {
      if (!results.some(r => r.assetId === row.assetId)) {
        results.push({
          type: "asset",
          assetId: row.assetId,
          assetTitle: row.asset_title || "(無題)",
          assetKind: row.asset_kind,
          assetStatus: row.asset_status,
          thumbnailUrl: resolveImageUrl(row.asset_thumbnailUrl, row.asset_storageProvider, row.asset_storageKey, row.asset_kind),
          storageUrl: row.asset_storageUrl,
          snippets: [`タグ/人物: ${row.entity_name}`],
          matchField: "entity",
          score: 2,
          createdAt: row.asset_createdAt,
          canonicalDate: row.asset_canonicalDate,
          personNames: [],
        });
      }
    }
  }

  // Sort by score descending, then by date
  results.sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime());

  const sliced = results.slice(0, perPage);

  // Batch fetch person names
  const assetIds = [...new Set(sliced.map((r) => r.assetId))];
  const personMap = await getPersonNames(assetIds);
  for (const item of sliced) {
    item.personNames = personMap.get(item.assetId) ?? [];
  }

  return {
    items: sliced,
    total: results.length,
    page,
    perPage,
  };
}
