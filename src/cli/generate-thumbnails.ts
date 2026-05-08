/**
 * Backfill R2 thumbnails for existing image and video assets.
 *
 * Usage:
 *   pnpm cli:thumbnails                          # Process all missing (images + videos)
 *   pnpm cli:thumbnails --force                   # Regenerate all
 *   pnpm cli:thumbnails --id=xxx                  # Single asset
 *   pnpm cli:thumbnails --kind=video              # Videos only
 *   pnpm cli:thumbnails --kind=image              # Images only
 *   pnpm cli:thumbnails --talk-thumbnails=/path   # Use Talk thumbnails from local dir
 */

import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
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

/**
 * talk-thumbnails ディレクトリ内のファイルからメッセージIDのインデックスを構築する。
 * ファイル名は {message_id}.{ext} の形式。
 */
function buildThumbnailIndex(dir: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!existsSync(dir)) return index;

  for (const file of readdirSync(dir)) {
    const msgId = file.replace(/\.[^.]+$/, "");
    index.set(msgId, join(dir, file));
  }
  return index;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const singleId = args.find((a) => a.startsWith("--id="))?.split("=")[1];
  const kindFilter = args.find((a) => a.startsWith("--kind="))?.split("=")[1];
  const talkThumbDir = args.find((a) => a.startsWith("--talk-thumbnails="))?.split("=")[1];

  // --talk-thumbnails モード: Talk のサムネイルファイルから動画サムネイルを生成
  if (talkThumbDir) {
    const thumbIndex = buildThumbnailIndex(talkThumbDir);
    console.log(`Loaded ${thumbIndex.size} thumbnail files from ${talkThumbDir}`);

    // talk_message_id を持つ動画アセットを取得
    const where: Record<string, unknown> = {
      kind: "video",
      sourceRecords: {
        some: {
          metadata: { path: ["talk_message_id"], not: "null" },
        },
      },
    };

    if (singleId) {
      where.id = singleId;
    } else if (!force) {
      where.OR = [
        { thumbnailUrl: null },
        { thumbnailUrl: { not: { startsWith: R2_PUBLIC_URL } } },
      ];
    }

    const assets = await prisma.asset.findMany({
      where,
      select: {
        id: true,
        title: true,
        thumbnailUrl: true,
        sourceRecords: {
          select: { metadata: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    console.log(`Found ${assets.length} video assets with talk_message_id`);

    let success = 0;
    let noThumb = 0;
    let failed = 0;

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const talkMsgId = asset.sourceRecords
        .map((sr) => (sr.metadata as Record<string, unknown>)?.talk_message_id)
        .find((id) => id != null) as string | undefined;

      if (!talkMsgId) {
        failed++;
        continue;
      }

      const thumbPath = thumbIndex.get(talkMsgId);
      if (!thumbPath) {
        console.log(`[${i + 1}/${assets.length}] ${asset.title || asset.id} — no thumbnail file for ${talkMsgId}`);
        noThumb++;
        continue;
      }

      try {
        console.log(`[${i + 1}/${assets.length}] ${asset.title || asset.id}`);
        const buffer = readFileSync(thumbPath);
        const url = await generateAndUpload(asset.id, buffer);
        await prisma.asset.update({
          where: { id: asset.id },
          data: { thumbnailUrl: url },
        });
        success++;
      } catch (err) {
        console.error(`  Failed: ${(err as Error).message}`);
        failed++;
      }
    }

    console.log(`\nDone: ${success} success, ${noThumb} no thumbnail file, ${failed} failed`);
    await prisma.$disconnect();
    return;
  }

  // 通常モード: Drive から画像をダウンロードしてサムネイル生成
  const where: Record<string, unknown> = {
    storageProvider: "gdrive",
    storageKey: { not: null },
  };

  if (kindFilter === "image" || kindFilter === "video") {
    where.kind = kindFilter;
  } else {
    where.kind = { in: ["image", "video"] };
  }

  if (singleId) {
    where.id = singleId;
    delete where.kind;
  } else if (!force) {
    where.OR = [
      { thumbnailUrl: null },
      { thumbnailUrl: { not: { startsWith: R2_PUBLIC_URL } } },
    ];
  }

  const assets = await prisma.asset.findMany({
    where,
    select: { id: true, title: true, kind: true, storageKey: true, thumbnailUrl: true },
    orderBy: { createdAt: "desc" },
  });

  console.log(`Found ${assets.length} assets to process`);

  let success = 0;
  let failed = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < assets.length; i += BATCH_SIZE) {
    const batch = assets.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (asset) => {
        try {
          const idx = i + batch.indexOf(asset) + 1;
          console.log(`[${idx}/${assets.length}] (${asset.kind}) ${asset.title || asset.id}`);

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

    if (i + BATCH_SIZE < assets.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log(`\nDone: ${success} success, ${failed} failed`);
  await prisma.$disconnect();
}

main().catch(console.error);
