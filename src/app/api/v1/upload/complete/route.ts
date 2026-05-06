import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/db";
import { finalizeDriveUpload, downloadFromDrive } from "@/lib/drive";
import { createAsset, updateAsset, type CreateAssetData } from "@/lib/domain/assets";
import { logAudit } from "@/lib/domain/audit";
import { generateAndUploadThumbnails } from "@/lib/thumbnails";
import type { AssetKind, AssetStatus, StorageProvider, SourceType } from "@prisma/client";

function guessMimeKind(mimeType: string): AssetKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("text/")) return "text";
  if (mimeType.includes("pdf") || mimeType.includes("document"))
    return "document";
  return "other";
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json();
  const {
    driveFileId,
    filename,
    mimeType,
    fileSize,
    sha256,
    title,
    kind: kindOverride,
    status: statusStr,
    canonicalDate: canonicalDateStr,
    sourceType: sourceTypeStr,
    entities,
    sourceRecords: rawSourceRecords,
    texts,
  } = body as {
    driveFileId: string;
    filename: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
    title?: string;
    kind?: AssetKind;
    status?: AssetStatus;
    canonicalDate?: string;
    sourceType?: SourceType;
    entities?: Array<{ entityId: string; roleLabel?: string }>;
    sourceRecords?: Array<Record<string, unknown>>;
    texts?: Array<{ textType: string; content: string; language?: string }>;
  };

  if (!driveFileId || !sha256) {
    return NextResponse.json(
      { error: "driveFileId and sha256 are required" },
      { status: 400 }
    );
  }

  const kind = kindOverride || guessMimeKind(mimeType || "application/octet-stream");

  // publishedAt を Date に変換
  const sourceRecords = rawSourceRecords?.map(
    (s: Record<string, unknown>) => ({
      ...s,
      publishedAt: s.publishedAt ? new Date(s.publishedAt as string) : null,
    })
  );

  // 重複チェック
  const existing = await prisma.asset.findFirst({ where: { sha256 } });
  if (existing) {
    const hasMetadata =
      statusStr || sourceTypeStr || canonicalDateStr || entities || sourceRecords || texts;
    if (hasMetadata) {
      await updateAsset(
        existing.id,
        {
          ...(statusStr && { status: statusStr }),
          ...(sourceTypeStr && { sourceType: sourceTypeStr }),
          ...(canonicalDateStr && {
            canonicalDate: new Date(canonicalDateStr),
          }),
          entities,
          sourceRecords: sourceRecords as CreateAssetData["sourceRecords"],
        },
        auth.id
      );
    }
    return NextResponse.json({
      duplicate: true,
      existingId: existing.id,
      message: `Duplicate file: ${existing.title || existing.id}`,
    });
  }

  // Drive のファイルに公開権限を付与しメタデータ取得
  let storageProvider: StorageProvider = "gdrive";
  let storageUrl: string | null = null;
  let storageKey: string | null = null;
  let thumbnailUrl: string | null = null;

  try {
    const driveResult = await finalizeDriveUpload(driveFileId);
    storageUrl = driveResult.webViewLink;
    storageKey = driveResult.fileId;
  } catch (err) {
    console.error("Failed to finalize Drive upload:", err);
    return NextResponse.json(
      { error: "Failed to finalize Google Drive upload" },
      { status: 500 }
    );
  }

  if (kind === "image" && storageUrl) {
    thumbnailUrl = storageUrl;
  }

  const asset = await createAsset(
    {
      kind,
      title: title || filename || "",
      description: "",
      status: statusStr || "inbox",
      sourceType: sourceTypeStr || "import",
      storageProvider,
      storageUrl,
      storageKey,
      sha256,
      originalFilename: filename,
      mimeType: mimeType || "application/octet-stream",
      fileSize: fileSize || null,
      thumbnailUrl,
      canonicalDate: canonicalDateStr ? new Date(canonicalDateStr) : null,
      entities,
      sourceRecords: sourceRecords as CreateAssetData["sourceRecords"],
      texts: texts as CreateAssetData["texts"],
    },
    auth.id
  );

  // Generate R2 thumbnails for images
  if (kind === "image" && storageKey) {
    try {
      const buffer = await downloadFromDrive(storageKey);
      if (buffer) {
        const r2Url = await generateAndUploadThumbnails(asset.id, buffer);
        if (r2Url) {
          await prisma.asset.update({
            where: { id: asset.id },
            data: { thumbnailUrl: r2Url },
          });
        }
      }
    } catch (err) {
      console.error("R2 thumbnail generation failed:", err);
      // Non-blocking — asset is still created
    }
  }

  await logAudit({
    actorId: auth.id,
    action: "asset.create_upload_api",
    targetType: "Asset",
    targetId: asset.id,
    metadata: { filename, sha256, apiKeyId: auth.apiKeyId },
  });

  return NextResponse.json({ id: asset.id, duplicate: false }, { status: 201 });
}
