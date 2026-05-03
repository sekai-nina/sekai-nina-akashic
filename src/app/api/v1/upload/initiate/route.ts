import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/db";
import { createResumableUploadSession, isDriveEnabled } from "@/lib/drive";
import { updateAsset, type CreateAssetData } from "@/lib/domain/assets";

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json();
  const { filename, mimeType, sha256, metadata } = body as {
    filename: string;
    mimeType: string;
    sha256?: string;
    metadata?: {
      status?: string;
      sourceType?: string;
      canonicalDate?: string;
      entities?: Array<{ entityId: string; roleLabel?: string }>;
      sourceRecords?: Array<Record<string, unknown>>;
    };
  };

  if (!filename || !mimeType) {
    return NextResponse.json(
      { error: "filename and mimeType are required" },
      { status: 400 }
    );
  }

  // sha256 が渡された場合は重複チェック
  if (sha256) {
    const existing = await prisma.asset.findFirst({ where: { sha256 } });
    if (existing) {
      // メタデータがあれば既存アセットに付与（既存の /upload と同じ動作）
      if (metadata) {
        const sourceRecords = metadata.sourceRecords?.map(
          (s: Record<string, unknown>) => ({
            ...s,
            publishedAt: s.publishedAt
              ? new Date(s.publishedAt as string)
              : null,
          })
        );
        await updateAsset(
          existing.id,
          {
            ...(metadata.status && { status: metadata.status }),
            ...(metadata.sourceType && { sourceType: metadata.sourceType }),
            ...(metadata.canonicalDate && {
              canonicalDate: new Date(metadata.canonicalDate),
            }),
            entities: metadata.entities,
            sourceRecords: sourceRecords as CreateAssetData["sourceRecords"],
          } as Parameters<typeof updateAsset>[1],
          auth.id
        );
      }
      return NextResponse.json({
        duplicate: true,
        existingId: existing.id,
        message: `Duplicate file: ${existing.title || existing.id}`,
      });
    }
  }

  if (!isDriveEnabled()) {
    return NextResponse.json(
      {
        error:
          "Google Drive is not configured. File upload requires Google Drive.",
      },
      { status: 503 }
    );
  }

  try {
    const uploadUrl = await createResumableUploadSession(filename, mimeType);
    if (!uploadUrl) {
      return NextResponse.json(
        { error: "Failed to create upload session" },
        { status: 500 }
      );
    }
    return NextResponse.json({ uploadUrl, duplicate: false });
  } catch (err) {
    console.error("Failed to create resumable upload session:", err);
    return NextResponse.json(
      { error: "Failed to create upload session" },
      { status: 500 }
    );
  }
}
