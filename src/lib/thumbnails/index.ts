import sharp from "sharp";
import type { Prisma } from "@prisma/client";
import { uploadToR2, isR2Configured, getR2PublicUrl } from "@/lib/r2";

/**
 * 「R2 にサムネイルが無い」画像・動画の条件。
 * `pnpm cli:thumbnails` の対象と `/status` の未生成件数が同じ集合を見るための共通定義
 * (別々に書くと「CLI では対象外なのに status では永久に減らない」ズレが黙って生まれる)。
 * Drive 以外 (discord_url / external_url / local_none) は CLI が処理できないので含めない。
 * `R2_PUBLIC_URL` が空だと `startsWith: ""` が全件に一致して条件が壊れるので、呼び出し側は
 * `isR2Configured()` を先に見る。
 */
export function thumbnailPendingWhere(): Prisma.AssetWhereInput {
  const publicUrl = process.env.R2_PUBLIC_URL ?? "";
  return {
    kind: { in: ["image", "video"] },
    storageProvider: "gdrive",
    storageKey: { not: null },
    OR: [{ thumbnailUrl: null }, { thumbnailUrl: { not: { startsWith: publicUrl } } }],
  };
}

const GALLERY_WIDTH = 640;
const LIST_WIDTH = 200;

export async function generateThumbnails(buffer: Buffer): Promise<{
  gallery: Buffer;
  list: Buffer;
}> {
  const [gallery, list] = await Promise.all([
    sharp(buffer)
      .resize(GALLERY_WIDTH, null, { withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer(),
    sharp(buffer)
      .resize(LIST_WIDTH, null, { withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer(),
  ]);
  return { gallery, list };
}

export async function uploadThumbnailsToR2(
  assetId: string,
  gallery: Buffer,
  list: Buffer
): Promise<string> {
  await Promise.all([
    uploadToR2(`thumbnails/${assetId}/gallery.webp`, gallery, "image/webp"),
    uploadToR2(`thumbnails/${assetId}/list.webp`, list, "image/webp"),
  ]);
  return getR2PublicUrl(`thumbnails/${assetId}/gallery.webp`);
}

/**
 * Generate thumbnails from image buffer and upload to R2.
 * Returns the gallery thumbnail URL, or null if R2 is not configured.
 */
export async function generateAndUploadThumbnails(
  assetId: string,
  imageBuffer: Buffer
): Promise<string | null> {
  if (!isR2Configured()) return null;

  try {
    const { gallery, list } = await generateThumbnails(imageBuffer);
    return await uploadThumbnailsToR2(assetId, gallery, list);
  } catch (err) {
    console.error(`Failed to generate thumbnails for ${assetId}:`, err);
    return null;
  }
}
