/**
 * Lighten existing dossier external images stored in R2.
 *
 * Historically `kind=external_image` items stored the full-resolution original
 * (up to 20 MB) at `externalImageKey`. We no longer keep originals — the
 * click-through view should be a lightweight 640px WebP, matching the blog/talk
 * thumbnail pipeline (640px WebP, quality 80) and the new upload route.
 *
 * For each legacy item this script:
 *   1. re-encodes the stored image to a 640px WebP, and
 *   2. uploads it to a NEW key `dossiers/{dossierId}/{itemId}/image.webp`
 *      (the same scheme new uploads use), then
 *   3. points both externalImageKey and externalImageThumbKey at the new key, and
 *   4. deletes the old (heavy) R2 objects.
 *
 * A new key is used — rather than overwriting in place — because the old objects
 * are served with `immutable, max-age=1y` cache headers, so a same-key overwrite
 * would keep serving the stale heavy bytes from the Cloudflare CDN for ~1 year.
 * A fresh key sidesteps the stale cache and reflects immediately.
 *
 * Usage:
 *   npx tsx src/cli/lighten-dossier-images.ts [--dry-run] [--limit=N] [--force]
 */

import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import "dotenv/config";

// Dossier / DossierItem have RLS enabled, and the default `app_runtime` role
// sees 0 rows without a session GUC. Connect via DIRECT_URL (`postgres`), which
// bypasses RLS — the same client the app uses for internal/CLI work.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL ?? "";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? "akashic-thumbnails";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  },
});

const GALLERY_WIDTH = 640;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1]) : 0;

  if (!R2_PUBLIC_URL || !process.env.R2_ACCOUNT_ID) {
    console.error("R2 is not configured (R2_PUBLIC_URL / R2_ACCOUNT_ID missing)");
    process.exit(1);
  }
  if (!process.env.DIRECT_URL) {
    console.error("DIRECT_URL is required (postgres role, bypasses RLS)");
    process.exit(1);
  }

  const items = await prisma.dossierItem.findMany({
    where: { kind: "external_image", externalImageKey: { not: null } },
    select: {
      id: true,
      dossierId: true,
      externalImageKey: true,
      externalImageThumbKey: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${items.length} external_image items with an image key`);

  let processed = 0;
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;

  for (const item of items) {
    if (limit && processed >= limit) break;
    const oldKey = item.externalImageKey!;
    const oldThumbKey = item.externalImageThumbKey ?? null;
    processed++;

    const newKey = `dossiers/${item.dossierId}/${item.id}/image.webp`;

    // Already migrated: both pointers are the unified image.webp key.
    if (!force && oldKey === newKey && oldThumbKey === newKey) {
      skipped++;
      continue;
    }

    try {
      const res = await fetch(`${R2_PUBLIC_URL}/${oldKey}`);
      if (!res.ok) {
        console.error(`  [${item.id}] fetch ${res.status} for ${oldKey}`);
        errors++;
        continue;
      }
      const source = Buffer.from(await res.arrayBuffer());
      bytesBefore += source.length;

      const image = await sharp(source)
        .rotate()
        .resize(GALLERY_WIDTH, null, { withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      bytesAfter += image.length;

      console.log(
        `  [${item.id}] ${kb(source.length)} -> ${kb(image.length)}  ${oldKey} -> ${newKey}` +
          (dryRun ? " (dry-run)" : "")
      );

      if (dryRun) {
        migrated++;
        continue;
      }

      // 1. Upload the lightweight image to the new key.
      await s3.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: newKey,
          Body: image,
          ContentType: "image/webp",
          CacheControl: "public, max-age=31536000, immutable",
        })
      );

      // 2. Point both pointers at the new key (single object, as new uploads do).
      await prisma.dossierItem.update({
        where: { id: item.id },
        data: { externalImageKey: newKey, externalImageThumbKey: newKey },
      });

      // 3. Delete the old heavy objects (anything that isn't the new key).
      const staleKeys = [oldKey, oldThumbKey].filter(
        (k): k is string => !!k && k !== newKey
      );
      for (const k of [...new Set(staleKeys)]) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: k })
        );
      }

      migrated++;
    } catch (err) {
      console.error(`  [${item.id}] error: ${(err as Error).message.slice(0, 160)}`);
      errors++;
    }
  }

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  console.log(
    `\nDone: ${processed} processed, ${migrated} migrated, ${skipped} skipped, ${errors} errors`
  );
  console.log(`Size: ${mb(bytesBefore)} -> ${mb(bytesAfter)} (across fetched objects)`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
