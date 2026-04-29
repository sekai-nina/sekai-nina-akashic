import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

export interface MentionResult {
  assetId: string;
  assetTitle: string;
  assetKind: string;
  textId: string;
  textType: string;
  matchedAlias: string;
  snippet: string;
  canonicalDate: Date | null;
  createdAt: Date;
}

function buildSnippet(text: string, query: string, contextLen = 100): string {
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

/**
 * Search all AssetText records for mentions of an entity's canonical name and aliases.
 */
export async function searchMentions(entityId: string): Promise<MentionResult[]> {
  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  if (!entity) return [];

  const aliases = (entity.aliases as string[]) || [];
  const searchTerms = [entity.canonicalName, ...aliases].filter(Boolean);

  if (searchTerms.length === 0) return [];

  // Build OR conditions for each alias
  const conditions = searchTerms.map(
    (term) => Prisma.sql`t."content" ILIKE ${"%" + term + "%"}`
  );

  const rows = await prisma.$queryRaw<Array<{
    assetId: string;
    assetTitle: string;
    assetKind: string;
    textId: string;
    textType: string;
    content: string;
    canonicalDate: Date | null;
    createdAt: Date;
  }>>`
    SELECT
      a."id" as "assetId",
      a."title" as "assetTitle",
      a."kind" as "assetKind",
      t."id" as "textId",
      t."textType" as "textType",
      t."content",
      a."canonicalDate",
      a."createdAt"
    FROM "AssetText" t
    JOIN "Asset" a ON a."id" = t."assetId"
    WHERE (${Prisma.join(conditions, " OR ")})
    ORDER BY a."canonicalDate" DESC NULLS LAST, a."createdAt" DESC
  `;

  // For each row, determine which alias matched
  const results: MentionResult[] = [];
  for (const row of rows) {
    const contentLower = row.content.toLowerCase();
    const matchedAlias = searchTerms.find((term) =>
      contentLower.includes(term.toLowerCase())
    ) ?? searchTerms[0];

    results.push({
      assetId: row.assetId,
      assetTitle: row.assetTitle,
      assetKind: row.assetKind,
      textId: row.textId,
      textType: row.textType,
      matchedAlias,
      snippet: buildSnippet(row.content, matchedAlias),
      canonicalDate: row.canonicalDate,
      createdAt: row.createdAt,
    });
  }

  return results;
}
