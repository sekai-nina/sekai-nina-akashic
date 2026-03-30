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
  snippet: string;
  matchField: string;
  score: number;
  createdAt: Date;
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

function buildSnippet(text: string, query: string, contextLen = 80): string {
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return text.slice(0, contextLen * 2) + (text.length > contextLen * 2 ? "…" : "");
  const start = Math.max(0, idx - contextLen);
  const end = Math.min(text.length, idx + query.length + contextLen);
  let snippet = "";
  if (start > 0) snippet += "…";
  snippet += text.slice(start, end);
  if (end < text.length) snippet += "…";
  return snippet;
}

export async function search(query: SearchQuery): Promise<SearchResult> {
  const { q, target = "all", page = 1, perPage = 20 } = query;
  const offset = (page - 1) * perPage;
  const hasKeyword = q.trim().length > 0;
  const normalizedQ = hasKeyword ? normalizeText(q) : "";

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
      ? Prisma.sql`(
          a."title" ILIKE ${'%' + q + '%'}
          OR a."description" ILIKE ${'%' + q + '%'}
          OR a."messageBodyPreview" ILIKE ${'%' + q + '%'}
          OR similarity(a."title", ${q}) > 0.1
          OR similarity(a."description", ${q}) > 0.1
        )`
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
      title_sim: number;
      desc_sim: number;
    }>>`
      SELECT
        a."id", a."title", a."description", a."kind", a."status",
        a."thumbnailUrl", a."storageUrl", a."storageProvider", a."storageKey",
        a."messageBodyPreview", a."createdAt",
        ${hasKeyword ? Prisma.sql`COALESCE(similarity(a."title", ${q}), 0)` : Prisma.sql`0`} as title_sim,
        ${hasKeyword ? Prisma.sql`COALESCE(similarity(a."description", ${q}), 0)` : Prisma.sql`0`} as desc_sim
      FROM "Asset" a
      WHERE ${keywordCondition}
      ${baseFilter}
      ${entityFilter}
      ORDER BY
        ${hasKeyword
          ? Prisma.sql`GREATEST(
              COALESCE(similarity(a."title", ${q}), 0) * 3,
              COALESCE(similarity(a."description", ${q}), 0) * 2
            ) DESC,`
          : Prisma.empty}
        a."createdAt" DESC
      LIMIT ${perPage} OFFSET ${offset}
    `;

    for (const row of assetResults) {
      const titleMatch = hasKeyword && row.title.toLowerCase().includes(q.toLowerCase());
      const descMatch = hasKeyword && row.description.toLowerCase().includes(q.toLowerCase());
      const matchField = titleMatch ? "title" : descMatch ? "description" : hasKeyword ? "messageBodyPreview" : "title";
      const matchText = titleMatch ? row.title : descMatch ? row.description : hasKeyword ? (row.messageBodyPreview || "") : row.title;
      results.push({
        type: "asset",
        assetId: row.id,
        assetTitle: row.title || "(無題)",
        assetKind: row.kind,
        assetStatus: row.status,
        thumbnailUrl: resolveImageUrl(row.thumbnailUrl, row.storageProvider, row.storageKey, row.kind),
        storageUrl: row.storageUrl,
        snippet: hasKeyword ? buildSnippet(matchText, q) : row.title,
        matchField,
        score: Math.max(Number(row.title_sim) * 3, Number(row.desc_sim) * 2),
        createdAt: row.createdAt,
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
      content_sim: number;
      asset_title: string;
      asset_kind: AssetKind;
      asset_status: AssetStatus;
      asset_thumbnailUrl: string | null;
      asset_storageUrl: string | null;
      asset_storageProvider: string | null;
      asset_storageKey: string | null;
      asset_createdAt: Date;
    }>>`
      SELECT
        t."id", t."assetId", t."textType", t."content",
        COALESCE(similarity(t."content", ${q}), 0) as content_sim,
        a."title" as asset_title, a."kind" as asset_kind, a."status" as asset_status,
        a."thumbnailUrl" as "asset_thumbnailUrl", a."storageUrl" as "asset_storageUrl",
        a."storageProvider" as "asset_storageProvider", a."storageKey" as "asset_storageKey",
        a."createdAt" as "asset_createdAt"
      FROM "AssetText" t
      JOIN "Asset" a ON a."id" = t."assetId"
      WHERE (
        t."content" ILIKE ${'%' + q + '%'}
        OR t."normalizedContent" ILIKE ${'%' + normalizedQ + '%'}
        OR similarity(t."content", ${q}) > 0.1
      )
      ${baseFilter}
      ${entityFilter}
      ORDER BY
        COALESCE(similarity(t."content", ${q}), 0) DESC,
        a."createdAt" DESC
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
        snippet: buildSnippet(row.content, q),
        matchField: row.textType,
        score: Number(row.content_sim),
        createdAt: row.asset_createdAt,
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
      entity_name: string;
      name_sim: number;
    }>>`
      SELECT DISTINCT ON (ae."assetId")
        ae."assetId",
        a."title" as asset_title, a."kind" as asset_kind, a."status" as asset_status,
        a."thumbnailUrl" as "asset_thumbnailUrl", a."storageUrl" as "asset_storageUrl",
        a."storageProvider" as "asset_storageProvider", a."storageKey" as "asset_storageKey",
        a."createdAt" as "asset_createdAt",
        e."canonicalName" as entity_name,
        COALESCE(similarity(e."canonicalName", ${q}), 0) as name_sim
      FROM "Entity" e
      JOIN "AssetEntity" ae ON ae."entityId" = e."id"
      JOIN "Asset" a ON a."id" = ae."assetId"
      WHERE (
        e."canonicalName" ILIKE ${'%' + q + '%'}
        OR e."normalizedName" ILIKE ${'%' + normalizedQ + '%'}
        OR similarity(e."canonicalName", ${q}) > 0.2
      )
      ${baseFilter}
      ORDER BY ae."assetId", COALESCE(similarity(e."canonicalName", ${q}), 0) DESC
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
          snippet: `タグ/人物: ${row.entity_name}`,
          matchField: "entity",
          score: Number(row.name_sim) * 2.5,
          createdAt: row.asset_createdAt,
        });
      }
    }
  }

  // Sort by score descending, then by date
  results.sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime());

  return {
    items: results.slice(0, perPage),
    total: results.length,
    page,
    perPage,
  };
}
