/**
 * Backfill AssetRelation records from {{IMG:asset_id}} placeholders in AssetText.
 *
 * Usage:
 *   npx tsx src/cli/backfill-relations.ts [--dry-run]
 */

import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

const IMG_REGEX = /\{\{IMG:([a-zA-Z0-9_-]+)\}\}/g;

async function main() {
  console.log(`Backfill asset relations from {{IMG:}} placeholders${dryRun ? " (DRY RUN)" : ""}`);

  // Find all AssetText records containing {{IMG:}} placeholders
  const texts = await prisma.assetText.findMany({
    where: { content: { contains: "{{IMG:" } },
    select: { id: true, assetId: true, content: true },
  });

  console.log(`Found ${texts.length} text records with image placeholders`);

  let created = 0;
  let skipped = 0;

  for (const text of texts) {
    const matches = [...text.content.matchAll(IMG_REGEX)];
    for (let i = 0; i < matches.length; i++) {
      const targetId = matches[i][1];

      // Skip numeric placeholders (not yet resolved to asset IDs)
      if (/^\d+$/.test(targetId)) continue;

      // Skip self-references
      if (targetId === text.assetId) continue;

      if (dryRun) {
        console.log(`  [DRY] ${text.assetId} -> ${targetId} (parent_child, sortOrder=${i})`);
        created++;
        continue;
      }

      try {
        await prisma.assetRelation.create({
          data: {
            sourceId: text.assetId,
            targetId,
            relationType: "parent_child",
            sortOrder: i,
            metadata: { source: "backfill_img_placeholder", textId: text.id },
          },
        });
        created++;
        console.log(`  Created: ${text.assetId} -> ${targetId}`);
      } catch (e) {
        // Unique constraint violation (P2002) = already exists
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          skipped++;
        } else {
          console.error(`  Error: ${text.assetId} -> ${targetId}:`, e);
        }
      }
    }
  }

  console.log(`\nDone. Created: ${created}, Skipped (duplicate): ${skipped}`);
}

main()
  .catch(console.error)
  .finally(async () => { await prisma.$disconnect(); });
