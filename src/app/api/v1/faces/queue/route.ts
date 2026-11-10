import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listFaceQueue, QUEUE_DEFAULT_LIMIT, QUEUE_MAX_LIMIT } from "@/lib/domain/faces";
import { FACE_WORKER_PERMISSION, MODEL_VERSION_PATTERN } from "@/lib/faces/policy";

/**
 * 顔認識 (#384): まだこのモデルで処理していない画像の一覧。推論ワーカーが叩く。
 * GET /api/v1/faces/queue?modelVersion=buffalo_l@1&limit=50&count=1
 * 残りの件数 (`remaining`) は画像全体を数えるので、`count=1` のときだけ返す (それ以外は null)
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const started = performance.now();
  const auth = await requireApiAuth(request, FACE_WORKER_PERMISSION);
  const authMs = performance.now() - started;
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const modelVersion = searchParams.get("modelVersion") ?? "";
  if (!MODEL_VERSION_PATTERN.test(modelVersion)) {
    return NextResponse.json({ error: "modelVersion は必須 (英数字と . _ @ : - の 64 文字まで)" }, { status: 400 });
  }
  const limit = Number(searchParams.get("limit") ?? QUEUE_DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > QUEUE_MAX_LIMIT) {
    return NextResponse.json({ error: `limit は 1..${QUEUE_MAX_LIMIT}` }, { status: 400 });
  }

  const withCount = searchParams.get("count") === "1";
  const queryStarted = performance.now();
  const { items, remaining } = await listFaceQueue(auth.clearance, modelVersion, limit, withCount);
  // ワーカーが 30 秒ごとに叩くので、遅いときだけどこで待ったかを残す (#416)
  const queryMs = performance.now() - queryStarted;
  if (authMs + queryMs >= 1_000) {
    console.warn(`[slow-queue] auth ${Math.round(authMs)}ms query ${Math.round(queryMs)}ms limit ${limit} count ${withCount}`);
  }
  return NextResponse.json({ items, remaining }, { headers: { "Cache-Control": "no-store" } });
}
