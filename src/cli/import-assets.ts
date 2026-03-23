/**
 * アセットを一括インポートするCLIスクリプト
 *
 * Usage:
 *   pnpm cli:import <json-file>
 *
 * JSONファイル形式:
 * [
 *   {
 *     "kind": "image",
 *     "title": "ブログ写真",
 *     "description": "2024年1月のブログ投稿",
 *     "sourceType": "web",
 *     "storageProvider": "external_url",
 *     "storageUrl": "https://example.com/image.jpg",
 *     "canonicalDate": "2024-01-15",
 *     "texts": [{ "textType": "body", "content": "本文テキスト" }],
 *     "sourceRecords": [{ "sourceKind": "url", "url": "https://example.com/blog/1", "title": "ブログタイトル" }]
 *   }
 * ]
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { normalizeText } from "../lib/utils";

const prisma = new PrismaClient();

interface ImportAsset {
  kind: string;
  title?: string;
  description?: string;
  sourceType?: string;
  storageProvider?: string;
  storageUrl?: string;
  thumbnailUrl?: string;
  canonicalDate?: string;
  texts?: Array<{
    textType: string;
    content: string;
    language?: string;
  }>;
  entities?: Array<{
    entityId: string;
    roleLabel?: string;
  }>;
  sourceRecords?: Array<{
    sourceKind: string;
    title?: string;
    url?: string;
    publisher?: string;
    publishedAt?: string;
  }>;
}

async function main() {
  const [, , filePath, userEmail] = process.argv;

  if (!filePath) {
    console.error("Usage: pnpm cli:import <json-file> [user-email]");
    console.error(
      "  user-email defaults to admin@akashic.local"
    );
    process.exit(1);
  }

  const email = userEmail || "admin@akashic.local";
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  const raw = readFileSync(filePath, "utf-8");
  const assets: ImportAsset[] = JSON.parse(raw);

  console.log(`Importing ${assets.length} assets as ${user.email}...`);

  let success = 0;
  let failed = 0;

  for (const [i, data] of assets.entries()) {
    try {
      const asset = await prisma.$transaction(async (tx) => {
        const created = await tx.asset.create({
          data: {
            kind: data.kind as never,
            title: data.title || "",
            description: data.description || "",
            status: "inbox",
            sourceType: (data.sourceType as never) || "import",
            storageProvider: (data.storageProvider as never) || "local_none",
            storageUrl: data.storageUrl || null,
            thumbnailUrl: data.thumbnailUrl || null,
            canonicalDate: data.canonicalDate
              ? new Date(data.canonicalDate)
              : null,
            createdById: user.id,
            updatedById: user.id,
            texts: data.texts
              ? {
                  create: data.texts.map((t) => ({
                    textType: t.textType as never,
                    content: t.content,
                    normalizedContent: normalizeText(t.content),
                    language: t.language,
                    createdById: user.id,
                  })),
                }
              : undefined,
            entities: data.entities
              ? {
                  create: data.entities.map((e) => ({
                    entityId: e.entityId,
                    roleLabel: e.roleLabel,
                  })),
                }
              : undefined,
            sourceRecords: data.sourceRecords
              ? {
                  create: data.sourceRecords.map((s) => ({
                    sourceKind: s.sourceKind as never,
                    title: s.title || "",
                    url: s.url || null,
                    publisher: s.publisher || null,
                    publishedAt: s.publishedAt
                      ? new Date(s.publishedAt)
                      : null,
                  })),
                }
              : undefined,
          },
        });
        return created;
      });

      await prisma.auditLog.create({
        data: {
          actorId: user.id,
          action: "asset.create_import",
          targetType: "Asset",
          targetId: asset.id,
          metadata: { title: asset.title, source: filePath } as object,
        },
      });

      success++;
      console.log(`  [${i + 1}/${assets.length}] OK: ${data.title || asset.id}`);
    } catch (err) {
      failed++;
      console.error(
        `  [${i + 1}/${assets.length}] FAIL: ${data.title || "(untitled)"}`,
        err instanceof Error ? err.message : err
      );
    }
  }

  console.log(`\nDone: ${success} succeeded, ${failed} failed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
