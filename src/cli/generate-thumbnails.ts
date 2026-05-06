/**
 * Backfill R2 thumbnails for existing image assets.
 *
 * Usage:
 *   pnpm cli:thumbnails          # Process all missing
 *   pnpm cli:thumbnails --force  # Regenerate all
 *   pnpm cli:thumbnails --id=xxx # Single asset
 */

import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import "dotenv/config";

const prisma = new PrismaClient();

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL ?? "";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  },
});

function getDriveClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Google Drive not configured");
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: "v3", auth: oauth2Client });
}

async function downloadFromDrive(fileId: string): Promise<Buffer> {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data as ArrayBuffer);
}

async function generateAndUpload(assetId: string, buffer: Buffer): Promise<string> {
  const [gallery, list] = await Promise.all([
    sharp(buffer).resize(640, null, { withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
    sharp(buffer).resize(200, null, { withoutEnlargement: true }).webp({ quality: 75 }).toBuffer(),
  ]);

  const bucket = process.env.R2_BUCKET_NAME ?? "akashic-thumbnails";

  await Promise.all([
    s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `thumbnails/${assetId}/gallery.webp`,
      Body: gallery,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000, immutable",
    })),
    s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `thumbnails/${assetId}/list.webp`,
      Body: list,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000, immutable",
    })),
  ]);

  return `${R2_PUBLIC_URL}/thumbnails/${assetId}/gallery.webp`;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const singleId = args.find((a) => a.startsWith("--id="))?.split("=")[1];

  const where: Record<string, unknown> = {
    kind: "image",
    storageProvider: "gdrive",
    storageKey: { not: null },
  };

  if (singleId) {
    where.id = singleId;
  } else if (!force) {
    // Only process assets without R2 thumbnails
    where.OR = [
      { thumbnailUrl: null },
      { thumbnailUrl: { not: { startsWith: R2_PUBLIC_URL } } },
    ];
  }

  const assets = await prisma.asset.findMany({
    where,
    select: { id: true, title: true, storageKey: true, thumbnailUrl: true },
    orderBy: { createdAt: "desc" },
  });

  console.log(`Found ${assets.length} images to process`);

  let success = 0;
  let failed = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < assets.length; i += BATCH_SIZE) {
    const batch = assets.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (asset) => {
        try {
          console.log(`[${i + batch.indexOf(asset) + 1}/${assets.length}] ${asset.title || asset.id}`);
          const buffer = await downloadFromDrive(asset.storageKey!);
          const url = await generateAndUpload(asset.id, buffer);
          await prisma.asset.update({
            where: { id: asset.id },
            data: { thumbnailUrl: url },
          });
          return true;
        } catch (err) {
          console.error(`  Failed: ${(err as Error).message}`);
          return false;
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) success++;
      else failed++;
    }

    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < assets.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log(`\nDone: ${success} success, ${failed} failed`);
  await prisma.$disconnect();
}

main().catch(console.error);
