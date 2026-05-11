import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { withClearance } from "@/lib/db";
import { generateAndUploadThumbnails } from "@/lib/thumbnails";

/**
 * POST /api/v1/assets/{id}/thumbnail
 *
 * サムネイル画像をアップロードしてR2に保存する。
 * multipart/form-data で `file` フィールドに画像を送る。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  // RLS handles classification filtering: if asset is not accessible, findUnique returns null
  const asset = await withClearance(auth.clearance, (tx) =>
    tx.asset.findUnique({ where: { id } })
  );
  if (!asset) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const r2Url = await generateAndUploadThumbnails(id, buffer);
  if (!r2Url) {
    return NextResponse.json(
      { error: "R2 is not configured or thumbnail generation failed" },
      { status: 500 }
    );
  }

  await withClearance(auth.clearance, (tx) =>
    tx.asset.update({
      where: { id },
      data: { thumbnailUrl: r2Url },
    })
  );

  return NextResponse.json({ thumbnailUrl: r2Url });
}
