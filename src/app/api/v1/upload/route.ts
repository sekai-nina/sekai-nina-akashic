import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/db";
import { uploadToDrive, isDriveEnabled } from "@/lib/drive";
import { createAsset, type CreateAssetData } from "@/lib/domain/assets";
import { logAudit } from "@/lib/domain/audit";
import { createHash } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
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

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const title = (formData.get("title") as string) || "";
  const kindOverride = formData.get("kind") as AssetKind | null;
  const canonicalDateStr = formData.get("canonicalDate") as string | null;
  const sourceTypeStr = formData.get("sourceType") as SourceType | null;
  const statusStr = formData.get("status") as AssetStatus | null;
  const entitiesJson = formData.get("entities") as string | null;
  const sourceRecordsJson = formData.get("sourceRecords") as string | null;
  const textsJson = formData.get("texts") as string | null;

  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const mimeType = file.type || "application/octet-stream";
  const kind = kindOverride || guessMimeKind(mimeType);

  // 重複チェック
  const existing = await prisma.asset.findFirst({ where: { sha256 } });
  if (existing) {
    return NextResponse.json({
      duplicate: true,
      existingId: existing.id,
      message: `Duplicate file: ${existing.title || existing.id}`,
    });
  }

  let storageProvider: StorageProvider = "local_none";
  let storageUrl: string | null = null;
  let storageKey: string | null = null;
  let thumbnailUrl: string | null = null;

  if (isDriveEnabled()) {
    try {
      const driveResult = await uploadToDrive(buffer, file.name, mimeType);
      if (driveResult) {
        storageProvider = "gdrive";
        storageUrl = driveResult.webViewLink;
        storageKey = driveResult.fileId;
        if (kind === "image") {
          thumbnailUrl = `/api/drive-image/${driveResult.fileId}`;
        }
      }
    } catch (err) {
      console.error("Drive upload failed, falling back to local:", err);
    }
  }

  if (storageProvider === "local_none") {
    const uploadsDir = join(process.cwd(), "uploads");
    await mkdir(uploadsDir, { recursive: true });
    const ext = file.name.includes(".")
      ? file.name.slice(file.name.lastIndexOf("."))
      : "";
    const filename = `${sha256}${ext}`;
    const filepath = join(uploadsDir, filename);
    await writeFile(filepath, buffer);
    storageProvider = "external_url";
    storageUrl = `/api/files/${filename}`;
    storageKey = filename;
  }

  if (kind === "image" && storageUrl) {
    thumbnailUrl = storageUrl;
  }

  // オプショナルなメタデータをパース
  let entities: Array<{ entityId: string; roleLabel?: string }> | undefined;
  let sourceRecords:
    | Array<{
        sourceKind: string;
        title?: string;
        url?: string | null;
        publisher?: string | null;
        publishedAt?: Date | null;
        metadata?: Record<string, unknown>;
      }>
    | undefined;
  let texts:
    | Array<{ textType: string; content: string; language?: string }>
    | undefined;

  try {
    if (entitiesJson) entities = JSON.parse(entitiesJson);
    if (sourceRecordsJson) {
      const raw = JSON.parse(sourceRecordsJson);
      sourceRecords = raw.map((s: Record<string, unknown>) => ({
        ...s,
        publishedAt: s.publishedAt ? new Date(s.publishedAt as string) : null,
      }));
    }
    if (textsJson) texts = JSON.parse(textsJson);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in entities, sourceRecords, or texts" },
      { status: 400 }
    );
  }

  const asset = await createAsset(
    {
      kind,
      title: title || file.name,
      description: "",
      status: statusStr || "inbox",
      sourceType: sourceTypeStr || "import",
      storageProvider,
      storageUrl,
      storageKey,
      sha256,
      originalFilename: file.name,
      mimeType,
      fileSize: buffer.length,
      thumbnailUrl,
      canonicalDate: canonicalDateStr ? new Date(canonicalDateStr) : null,
      entities,
      sourceRecords: sourceRecords as CreateAssetData["sourceRecords"],
      texts: texts as CreateAssetData["texts"],
    },
    auth.id
  );

  await logAudit({
    actorId: auth.id,
    action: "asset.create_upload_api",
    targetType: "Asset",
    targetId: asset.id,
    metadata: { filename: file.name, sha256, apiKeyId: auth.apiKeyId },
  });

  return NextResponse.json({ id: asset.id, duplicate: false }, { status: 201 });
}
