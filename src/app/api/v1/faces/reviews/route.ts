import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateAssetList } from "@/lib/cache";
import { FACE_REVIEW_CACHE_TAG, FaceDecisionsInput, FaceReviewInputError, reviewFaces } from "@/lib/domain/face-review";

/**
 * 顔認識 (#441): 顔の確定・却下を保存する。画面の「顔の確認」(/faces) と同じ規則 (`reviewFaces`)。
 * POST /api/v1/faces/reviews  { "decisions": [{ "faceId": "...", "action": "confirm" | "reject" | "nonmember" | "other", "entityId"? }] }
 * discord bot が ✅ / ❌ のリアクションから叩く。判断した人 (reviewedById) はキーの持ち主になる。
 * 判断し直しもできる (後から付けたリアクションで上書きする)
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON ではない" }, { status: 400 });
  }
  const parsed = FaceDecisionsInput.safeParse((body as { decisions?: unknown } | null)?.decisions);
  if (!parsed.success) return NextResponse.json({ error: "decisions の形が違う", issues: parsed.error.issues }, { status: 400 });

  try {
    const result = await reviewFaces(auth, parsed.data);
    if (result.tagsAdded > 0 || result.tagsRemoved > 0) invalidateAssetList();
    revalidateTag(FACE_REVIEW_CACHE_TAG, "max");
    return NextResponse.json(result);
  } catch (err) {
    // 見えない・消えた顔 (モデルの版を上げて作り直された等) は 404、それ以外の形の誤りは 400
    if (err instanceof FaceReviewInputError) {
      const status = err.message === "見つからない顔がある" ? 404 : 400;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
