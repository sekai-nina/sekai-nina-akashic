import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeText } from "@/lib/utils";
import { uploadToDrive, isDriveEnabled } from "@/lib/drive";
import { createHash } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";
import type { AssetKind, StorageProvider } from "@prisma/client";

function guessMimeKind(mimeType: string): AssetKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("text/")) return "text";
  if (mimeType.includes("pdf") || mimeType.includes("document")) return "document";
  return "other";
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = (session.user as { role: string }).role;
  if (!["admin", "member"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const title = (formData.get("title") as string) || "";
  const kindOverride = formData.get("kind") as AssetKind | null;

  if (!file) {
    return NextResponse.json({ error: "ファイルが必要です" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const mimeType = file.type || "application/octet-stream";
  const kind = kindOverride || guessMimeKind(mimeType);

  // Check duplicate
  const existing = await prisma.asset.findFirst({ where: { sha256 } });
  if (existing) {
    return NextResponse.json({
      duplicate: true,
      existingId: existing.id,
      message: `同一ファイルが既に登録されています: ${existing.title || existing.id}`,
    });
  }

  let storageProvider: StorageProvider = "local_none";
  let storageUrl: string | null = null;
  let storageKey: string | null = null;
  let thumbnailUrl: string | null = null;

  // Try Google Drive first
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

  // Fall back to local storage
  if (storageProvider === "local_none") {
    const uploadsDir = join(process.cwd(), "uploads");
    await mkdir(uploadsDir, { recursive: true });
    const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
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

  const asset = await prisma.asset.create({
    data: {
      kind,
      title: title || file.name,
      description: "",
      status: "inbox",
      sourceType: "manual",
      storageProvider,
      storageUrl,
      storageKey,
      sha256,
      originalFilename: file.name,
      mimeType,
      fileSize: buffer.length,
      thumbnailUrl,
      createdById: session.user.id,
      updatedById: session.user.id,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "asset.create_upload",
      targetType: "Asset",
      targetId: asset.id,
      metadata: { filename: file.name, sha256 } as object,
    },
  });

  return NextResponse.json({ id: asset.id, duplicate: false });
}
