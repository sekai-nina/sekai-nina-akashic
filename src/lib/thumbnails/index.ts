import sharp from "sharp";
import { uploadToR2, isR2Configured, getR2PublicUrl } from "@/lib/r2";

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
