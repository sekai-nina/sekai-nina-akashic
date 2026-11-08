import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateAssetList } from "@/lib/cache";
import { FaceAssetNotFoundError, FaceInputError, writeFaceResults } from "@/lib/domain/faces";
import { FACE_WORKER_PERMISSION, FaceWriteBody } from "@/lib/faces/policy";
import { formatZodError } from "@/lib/zod-error";

/**
 * 顔認識 (#384): 1 枚の画像の推論結果を書き込む。同じ画像の、人が見ていない結果は置き換える。
 * 閾値以上の顔は AssetEntity (roleLabel = face) を自動で付ける。規則は docs/face-design.md
 */
export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, FACE_WORKER_PERMISSION);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = FaceWriteBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  try {
    const result = await writeFaceResults(auth.clearance, id, parsed.data);
    // 初回は約 7 万回叩かれるので、ダッシュボード統計まで捨てる invalidateAssets ではなく一覧だけにする
    // (src/lib/cache.ts の注記。外部 bot からの書き込みは invalidateAssetList)
    if (result.tagsAdded.length > 0 || result.tagsRemoved.length > 0) invalidateAssetList();
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof FaceAssetNotFoundError) {
      return NextResponse.json({ error: "画像のアセットが見つかりません" }, { status: 404 });
    }
    if (err instanceof FaceInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
