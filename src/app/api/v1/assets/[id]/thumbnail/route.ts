import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { withClearance, prismaInternal } from "@/lib/db";
import { generateAndUploadThumbnails } from "@/lib/thumbnails";

/**
 * GET /api/v1/assets/{id}/thumbnail
 *
 * アセットのサムネイルへ 302 リダイレクトする（<img src> 埋め込み用・認証不要）。
 * asset id は cuid で推測不能なため、URL を知っている = ID を知っている前提の
 * 内部管理 UI 用途に限定した公開（coverage のサムネイルストリップ等）。
 * R2 の thumbnailUrl があればそこへ、gdrive はプロキシ (/api/drive-image) へ。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // 認証なし = clearance なしなので RLS 経由では引けない。internal client で
  // サムネイル関連カラムだけを引く（本文・メタは返さない）。
  const asset = await prismaInternal.asset.findUnique({
    where: { id },
    select: { thumbnailUrl: true, storageProvider: true, storageKey: true },
  });
  if (!asset) return new NextResponse(null, { status: 404 });

  const headers = { "Cache-Control": "private, max-age=3600" };
  if (asset.thumbnailUrl) {
    return NextResponse.redirect(asset.thumbnailUrl, { status: 302, headers });
  }
  if (asset.storageProvider === "gdrive" && asset.storageKey) {
    // drive-image プロキシはセッション認証必須（同一オリジンの <img> なら cookie が付く）
    return NextResponse.redirect(new URL(`/api/drive-image/${asset.storageKey}`, request.url), {
      status: 302,
      headers,
    });
  }
  return new NextResponse(null, { status: 404 });
}

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
