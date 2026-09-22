import type { AssetKind } from "@prisma/client";

/**
 * MIME から Asset.kind を決める。upload 系の route と story ワーカーで同じ判定を使う
 * (以前は 3 つの route にコピペされていた。#182)。
 */
export function guessMimeKind(mimeType: string): AssetKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("text/")) return "text";
  if (mimeType.includes("pdf") || mimeType.includes("document")) return "document";
  return "other";
}
