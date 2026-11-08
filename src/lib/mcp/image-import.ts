import path from "node:path";
import type { Metadata } from "sharp";

/**
 * `akashic_import_images` の純粋な部品 (DB を触らないのでテストから直接呼べる)。
 */

/** 受ける画像の形式。SVG はスクリプトを含められるので入れない */
export const IMAGE_FORMATS_LABEL = "JPEG / PNG / WebP / GIF / TIFF / HEIC / AVIF";

/** sharp の format → MIME と拡張子。対応外は null */
export function imageTypeOf(meta: Pick<Metadata, "format" | "compression">): { mimeType: string; ext: string } | null {
  switch (meta.format) {
    case "jpeg":
      return { mimeType: "image/jpeg", ext: "jpg" };
    case "png":
      return { mimeType: "image/png", ext: "png" };
    case "webp":
      return { mimeType: "image/webp", ext: "webp" };
    case "gif":
      return { mimeType: "image/gif", ext: "gif" };
    case "tiff":
      return { mimeType: "image/tiff", ext: "tiff" };
    case "heif":
      // sharp は AVIF も HEIC も heif と返す。圧縮方式で見分ける
      return meta.compression === "av1"
        ? { mimeType: "image/avif", ext: "avif" }
        : { mimeType: "image/heic", ext: "heic" };
    default:
      return null;
  }
}

/** ファイル名の本体 (拡張子を除く) の最大文字数 */
const FILENAME_BASE_MAX = 100;
/** URL から名前が取れないときに使う sha256 の先頭文字数 */
const FILENAME_SHA_PREFIX = 16;

/** Drive 上のファイル名。URL の末尾を使い、拡張子は中身に合わせる */
export function filenameFromUrl(url: string, ext: string, sha256: string): string {
  let base = "";
  try {
    base = decodeURIComponent(path.posix.basename(new URL(url).pathname));
  } catch {
    // 不正なエスケープは捨てる
  }
  base = base
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^\.+/, "");
  // 文字 (コードポイント) 単位で切る。slice だとサロゲートペアの片割れが残る
  base = Array.from(base).slice(0, FILENAME_BASE_MAX).join("");
  return `${base || sha256.slice(0, FILENAME_SHA_PREFIX)}.${ext}`;
}

/** Referer に載せられる形にする (ヘッダーは ASCII しか通らないので、日本語の URL はエスケープする) */
export function toHeaderSafeUrl(raw: string): string | null {
  try {
    const href = new URL(raw).href;
    return /^[\x21-\x7e]+$/.test(href) ? href : null;
  } catch {
    return null;
  }
}
