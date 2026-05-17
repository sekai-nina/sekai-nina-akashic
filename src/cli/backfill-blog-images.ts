/**
 * Backfill blog posts with embedded image placeholders.
 *
 * 1. Find blog text assets in DB (sourceRecord URL contains hinatazaka46 diary)
 * 2. Call blog_downloader via Python subprocess to get image positions
 * 3. Upload images to Google Drive + generate R2 thumbnails
 * 4. Replace {{IMG:N}} with {{IMG:asset_id}} in text content
 * 5. Update asset title to new format: (author)ブログ「(title)」
 *
 * Usage:
 *   npx tsx src/cli/backfill-blog-images.ts [--dry-run] [--limit N]
 */

import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { execSync } from "child_process";
import "dotenv/config";

const prisma = new PrismaClient();

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL ?? "";
const BLOG_DOWNLOADER_DIR = process.env.BLOG_DOWNLOADER_DIR
  ?? `${process.env.HOME}/project/hnt42-project/blog_downloader`;

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

async function uploadToDrive(buffer: Buffer, filename: string, mimeType: string) {
  const drive = getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: { mimeType, body: require("stream").Readable.from(buffer) },
    fields: "id,webViewLink",
    supportsAllDrives: true,
  });
  // Make publicly accessible
  await drive.permissions.create({
    fileId: res.data.id!,
    requestBody: { role: "reader", type: "anyone" },
    supportsAllDrives: true,
  });
  return { fileId: res.data.id!, webViewLink: res.data.webViewLink ?? "" };
}

async function generateR2Thumbnails(assetId: string, buffer: Buffer): Promise<string | null> {
  try {
    const gallery = await sharp(buffer)
      .resize(640, null, { withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const bucket = process.env.R2_BUCKET_NAME ?? "akashic-thumbnails";
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `thumbnails/${assetId}/gallery.webp`,
      Body: gallery,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000, immutable",
    }));

    return `${R2_PUBLIC_URL}/thumbnails/${assetId}/gallery.webp`;
  } catch {
    return null;
  }
}

interface BlogData {
  post_id: number;
  title: string;
  author: string;
  body_text_with_images: string;
  image_urls: string[];
  images: Array<{ url: string; data_b64: string; filename: string }>;
}

function fetchBlogPost(postId: number): BlogData | null {
  try {
    const script = `
import json, base64, sys
sys.path.insert(0, '${BLOG_DOWNLOADER_DIR}/src')
from blog_downloader.api import BlogClient
c = BlogClient(delay=0.5)
p = c.get_post(str(${postId}), ${postId}, fetch_images=True)
if not p:
    print(json.dumps(None))
else:
    print(json.dumps({
        "post_id": p.post_id,
        "title": p.title,
        "author": p.author,
        "body_text_with_images": p.body_text_with_images,
        "image_urls": p.image_urls,
        "images": [{"url": img.url, "data_b64": base64.b64encode(img.data).decode(), "filename": img.filename} for img in p.images],
    }))
`;
    const result = execSync(`cd "${BLOG_DOWNLOADER_DIR}" && uv run python -c '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 120000,
      maxBuffer: 100 * 1024 * 1024,
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result.trim().split("\n").pop()!);
    return parsed;
  } catch (err) {
    console.error(`  Python error: ${(err as Error).message.slice(0, 200)}`);
    return null;
  }
}

function extractPostId(url: string): number | null {
  const m = url.match(/hinatazaka46\.com\/s\/official\/diary\/detail\/(\d+)/);
  return m ? parseInt(m[1]) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find(a => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1]) : 0;

  // Find blog text assets with hinatazaka46 diary source records
  const blogAssets = await prisma.asset.findMany({
    where: {
      kind: "text",
      sourceType: "web",
      sourceRecords: {
        some: { url: { contains: "hinatazaka46.com/s/official/diary/detail" } },
      },
    },
    include: {
      texts: { where: { textType: "body" }, take: 1 },
      sourceRecords: true,
      entities: { include: { entity: true } },
    },
    orderBy: { canonicalDate: { sort: "desc", nulls: "last" } },
  });

  console.log(`Found ${blogAssets.length} blog assets`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const asset of blogAssets) {
    if (limit && processed >= limit) break;

    const bodyText = asset.texts[0];
    if (!bodyText) continue;

    // Extract post_id
    let postId: number | null = null;
    for (const sr of asset.sourceRecords) {
      postId = extractPostId(sr.url ?? "");
      if (postId) break;
    }
    if (!postId) continue;

    // No skip — always re-process for title/entity fixes

    processed++;
    console.log(`\n[${processed}] post_id=${postId} title=${asset.title?.slice(0, 40)}`);

    // Fetch blog from hinatazaka46.com
    const post = fetchBlogPost(postId);
    if (!post) {
      console.log("  Blog post not found or fetch failed");
      errors++;
      continue;
    }

    const newTitle = post.author && post.title
      ? `${post.author}ブログ「${post.title}」`
      : asset.title;

    if (!post.image_urls.length) {
      // No images, but still update title and text (for HTML entity fix)
      if (!dryRun) {
        await prisma.assetText.update({
          where: { id: bodyText.id },
          data: {
            content: post.body_text_with_images || bodyText.content,
            normalizedContent: (post.body_text_with_images || bodyText.content)
              .replace(/\{\{IMG:[a-zA-Z0-9_-]+\}\}/g, "")
              .toLowerCase().normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim(),
          },
        });
        if (newTitle !== asset.title) {
          await prisma.asset.update({ where: { id: asset.id }, data: { title: newTitle } });
        }
      }
      console.log("  No images, updated text/title");
      updated++;
      continue;
    }

    if (!post.body_text_with_images || !post.body_text_with_images.includes("{{IMG:")) {
      console.log("  No image placeholders");
      skipped++;
      continue;
    }

    // Upload images and collect asset IDs
    const imageAssetIds: Record<number, string> = {};
    const totalImgs = post.images.length;
    const entities = asset.entities;
    const sourceRecords = asset.sourceRecords;

    for (let i = 0; i < post.images.length; i++) {
      const img = post.images[i];
      const imgIndex = post.image_urls.indexOf(img.url);
      if (imgIndex === -1) continue;

      const imageBuffer = Buffer.from(img.data_b64, "base64");
      const sha256 = createHash("sha256").update(imageBuffer).digest("hex");

      // Check duplicate
      const existing = await prisma.asset.findFirst({ where: { sha256 } });
      if (existing) {
        imageAssetIds[imgIndex] = existing.id;
        console.log(`  Image ${i + 1}/${totalImgs}: ${existing.id} (existing)`);
        // Generate R2 thumbnail if missing
        if (!existing.thumbnailUrl?.includes("r2.sekai-nina.com")) {
          const r2Url = await generateR2Thumbnails(existing.id, imageBuffer);
          if (r2Url) {
            await prisma.asset.update({ where: { id: existing.id }, data: { thumbnailUrl: r2Url } });
          }
        }
        continue;
      }

      const imageTitle = totalImgs > 1 ? `${newTitle} (${i + 1}/${totalImgs})` : newTitle!;
      console.log(`  Uploading ${i + 1}/${totalImgs}: ${img.filename}`);

      if (dryRun) {
        imageAssetIds[imgIndex] = `dry-run-${imgIndex}`;
        continue;
      }

      try {
        const driveResult = await uploadToDrive(imageBuffer, img.filename, "image/jpeg");
        const imageAsset = await prisma.asset.create({
          data: {
            kind: "image",
            title: imageTitle,
            description: "",
            status: "organized",
            sourceType: "web",
            storageProvider: "gdrive",
            storageUrl: driveResult.webViewLink,
            storageKey: driveResult.fileId,
            sha256,
            originalFilename: img.filename,
            mimeType: "image/jpeg",
            fileSize: imageBuffer.length,
            canonicalDate: asset.canonicalDate,
            entities: {
              create: entities.map(e => ({
                entityId: e.entityId,
                roleLabel: e.roleLabel ?? "",
              })),
            },
            sourceRecords: {
              create: sourceRecords.map(sr => ({
                sourceKind: sr.sourceKind,
                url: sr.url,
                title: sr.title,
                publisher: sr.publisher,
                publishedAt: sr.publishedAt,
              })),
            },
          },
        });

        // R2 thumbnail
        const r2Url = await generateR2Thumbnails(imageAsset.id, imageBuffer);
        if (r2Url) {
          await prisma.asset.update({ where: { id: imageAsset.id }, data: { thumbnailUrl: r2Url } });
        }

        imageAssetIds[imgIndex] = imageAsset.id;
        console.log(`    -> ${imageAsset.id}`);
      } catch (err) {
        console.error(`    Upload error: ${(err as Error).message.slice(0, 100)}`);
      }
    }

    // Replace {{IMG:N}} with {{IMG:asset_id}}
    let newContent = post.body_text_with_images;
    newContent = newContent.replace(/\{\{IMG:(\d+)\}\}/g, (match, n) => {
      const aid = imageAssetIds[parseInt(n)];
      return aid ? `{{IMG:${aid}}}` : match;
    });

    console.log(`  Updating text (${Object.keys(imageAssetIds).length} images resolved)`);
    if (!dryRun) {
      await prisma.assetText.update({
        where: { id: bodyText.id },
        data: {
          content: newContent,
          normalizedContent: newContent
            .replace(/\{\{IMG:[a-zA-Z0-9_-]+\}\}/g, "")
            .toLowerCase().normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim(),
        },
      });
      if (newTitle !== asset.title) {
        await prisma.asset.update({ where: { id: asset.id }, data: { title: newTitle } });
        console.log(`  Updated title: ${newTitle?.slice(0, 50)}`);
      }
    }
    updated++;
  }

  console.log(`\nDone: ${processed} processed, ${updated} updated, ${skipped} skipped, ${errors} errors`);
  await prisma.$disconnect();
}

main().catch(console.error);
