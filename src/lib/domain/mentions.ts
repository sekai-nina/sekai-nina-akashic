import { prisma, withClearance } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { normalizeText } from "@/lib/utils";

export interface MentionResult {
  assetId: string;
  assetTitle: string;
  assetKind: string;
  assetSourceType: string;
  textId: string;
  textType: string;
  matchedAliases: string[];
  block: string;
  canonicalDate: Date | null;
  createdAt: Date;
  linkedEntities: string;
  sourceInfo: string;
}

export interface SearchMentionsOptions {
  excludeLinked?: boolean;
  since?: Date;
  clearance?: string;
}

/**
 * Search all AssetText records for mentions of an entity's canonical name and aliases.
 * Splits text into blocks by newlines and detects all matching aliases per block.
 */
export async function searchMentions(
  entityId: string,
  options: SearchMentionsOptions = {}
): Promise<MentionResult[]> {
  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  if (!entity) return [];

  const aliases = (entity.aliases as string[]) || [];
  const searchTerms = [entity.canonicalName, ...aliases].filter(Boolean);

  if (searchTerms.length === 0) return [];

  const clearance = options.clearance ?? "public";

  return withClearance(clearance, async (tx) => {
    // Build OR conditions for each alias
    // ILIKE ではなく PGroonga の &@ を使う。ILIKE (texticlike) は leakproof でないため
    // RLS 下では索引が効かず AssetText を毎回 Seq Scan していた。
    // 索引は normalizedContent 側に張ってあるので検索語も normalizeText を通す。
    // (ブロック分割と一致語の判定は下流の JS 側が素の content に対して行うので、
    //  ここは絞り込みだけの役割)
    const conditions = searchTerms.map(
      (term) => Prisma.sql`t."normalizedContent" &@ ${normalizeText(term)}`
    );

    // Optionally exclude assets already linked to this entity
    const excludeClause = options.excludeLinked
      ? Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "AssetEntity" ae
          WHERE ae."assetId" = a."id" AND ae."entityId" = ${entityId}
        )`
      : Prisma.empty;

    // Optionally filter by date
    const sinceClause = options.since
      ? Prisma.sql`AND COALESCE(a."canonicalDate", a."createdAt") >= ${options.since}`
      : Prisma.empty;

    const rows = await tx.$queryRaw<Array<{
      assetId: string;
      assetTitle: string;
      assetKind: string;
      assetSourceType: string;
      textId: string;
      textType: string;
      content: string;
      canonicalDate: Date | null;
      createdAt: Date;
      linkedEntities: string | null;
      sourceInfo: string | null;
    }>>`
      SELECT
        a."id" as "assetId",
        a."title" as "assetTitle",
        a."kind" as "assetKind",
        a."sourceType" as "assetSourceType",
        t."id" as "textId",
        t."textType" as "textType",
        t."content",
        a."canonicalDate",
        a."createdAt",
        (
          SELECT string_agg(
            e2."canonicalName" || COALESCE(' (' || ae2."roleLabel" || ')', ''),
            ', '
          )
          FROM "AssetEntity" ae2
          JOIN "Entity" e2 ON e2."id" = ae2."entityId"
          WHERE ae2."assetId" = a."id"
            -- 種別を person / tag に限る。Entity の RLS は素通しなので、place を含めると
            -- 上位機密の聖地名が「関連:」欄と CSV に出てしまう
            AND e2.type IN ('person', 'tag')
        ) as "linkedEntities",
        (
          SELECT string_agg(
            sr."sourceKind" || COALESCE(': ' || sr."url", '') || COALESCE(' [' || sr."publisher" || ']', ''),
            '; '
          )
          FROM "SourceRecord" sr
          WHERE sr."assetId" = a."id"
        ) as "sourceInfo"
      FROM "AssetText" t
      JOIN "Asset" a ON a."id" = t."assetId"
      WHERE (${Prisma.join(conditions, " OR ")})
      ${excludeClause}
      ${sinceClause}
      ORDER BY a."canonicalDate" DESC NULLS LAST, a."createdAt" DESC
    `;

    // Split each text into blocks by newlines, detect all matching aliases per block
    const results: MentionResult[] = [];
    for (const row of rows) {
      const blocks = row.content.split(/\n{2,}/).filter((b) => b.trim());
      for (const block of blocks) {
        const blockLower = block.toLowerCase();
        const matched = searchTerms.filter((term) =>
          blockLower.includes(term.toLowerCase())
        );
        if (matched.length === 0) continue;

        results.push({
          assetId: row.assetId,
          assetTitle: row.assetTitle,
          assetKind: row.assetKind,
          assetSourceType: row.assetSourceType,
          textId: row.textId,
          textType: row.textType,
          matchedAliases: matched,
          block: block.trim(),
          canonicalDate: row.canonicalDate,
          createdAt: row.createdAt,
          linkedEntities: row.linkedEntities ?? "",
          sourceInfo: row.sourceInfo ?? "",
        });
      }
    }

    return results;
  });
}
