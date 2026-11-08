import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { FaceAssetNotFoundError, FaceOriginalTooLargeError, fetchFaceOriginal, ORIGINAL_MAX_BYTES } from "@/lib/domain/faces";
import { FACE_WORKER_PERMISSION } from "@/lib/faces/policy";

/**
 * 顔認識 (#384): 元画像のバイナリ。`/api/drive-image` はログインのセッションが要るので、ワーカー用に別に持つ。
 * 4.4 MB を超える画像は 413 (Vercel の応答上限)。ワーカーはサムネイルに落として処理する
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, FACE_WORKER_PERMISSION);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const { body, mimeType } = await fetchFaceOriginal(auth.clearance, id);
    return new NextResponse(new Uint8Array(body), {
      headers: { "Content-Type": mimeType, "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    if (err instanceof FaceAssetNotFoundError) {
      return NextResponse.json({ error: "画像のアセットが見つかりません" }, { status: 404 });
    }
    if (err instanceof FaceOriginalTooLargeError) {
      const mb = (ORIGINAL_MAX_BYTES / 1_000_000).toFixed(1);
      return NextResponse.json({ error: `元画像が大きすぎます (${mb} MB 超)。サムネイルを使ってください` }, { status: 413 });
    }
    const driveStatus = (err as { response?: { status?: number } })?.response?.status;
    if (driveStatus === 404) {
      return NextResponse.json({ error: "Drive にファイルがありません" }, { status: 404 });
    }
    console.error("[faces] 元画像の取得に失敗:", err);
    return NextResponse.json({ error: "元画像の取得に失敗しました" }, { status: 502 });
  }
}
