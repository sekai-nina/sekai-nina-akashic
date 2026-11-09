import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import {
  FaceAssetNotFoundError,
  FaceOriginalTooLargeError,
  FaceRangeError,
  fetchFaceOriginal,
  ORIGINAL_MAX_BYTES,
} from "@/lib/domain/faces";
import { FACE_WORKER_PERMISSION } from "@/lib/faces/policy";

/**
 * 顔認識 (#384): 元ファイルのバイナリ。`/api/drive-image` はログインのセッションが要るので、ワーカー用に別に持つ。
 * 4.4 MB を超えるものは 413 (Vercel の応答上限)。画像はワーカーがサムネイルに落として処理する。
 * 動画 (#403) は `Range: bytes=<start>-<end>` で 4.4 MB ずつ取る (206 と Content-Range を返す)。
 * `read` のキーでも取れる (#395。discord bot が写っている画像を流すため)。見えるのはキーのクリアランス以下だけ
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const RANGE_RE = /^bytes=(\d+)-(\d*)$/;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, [FACE_WORKER_PERMISSION, "read"]);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const rangeHeader = request.headers.get("range");
  let range: { start: number; end: number | null } | undefined;
  if (rangeHeader) {
    const m = RANGE_RE.exec(rangeHeader.trim());
    if (!m) return NextResponse.json({ error: "Range は bytes=<start>-<end> の 1 つだけ" }, { status: 416 });
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : null;
    if (end != null && end < start) return NextResponse.json({ error: "Range の end が start より前" }, { status: 416 });
    range = { start, end };
  }

  try {
    const { body, mimeType, range: served } = await fetchFaceOriginal(auth.clearance, id, range);
    const headers: Record<string, string> = {
      "Content-Type": mimeType,
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
    };
    if (served) {
      headers["Content-Range"] = `bytes ${served.start}-${served.end}/${served.total ?? "*"}`;
      return new NextResponse(new Uint8Array(body), { status: 206, headers });
    }
    return new NextResponse(new Uint8Array(body), { headers });
  } catch (err) {
    if (err instanceof FaceAssetNotFoundError) {
      return NextResponse.json({ error: "アセットが見つかりません" }, { status: 404 });
    }
    const mb = (ORIGINAL_MAX_BYTES / 1_000_000).toFixed(1);
    if (err instanceof FaceOriginalTooLargeError) {
      return NextResponse.json(
        { error: `大きすぎます (${mb} MB 超)。画像はサムネイルを、動画は Range で ${mb} MB ずつ取ってください` },
        { status: 413 }
      );
    }
    if (err instanceof FaceRangeError) {
      return NextResponse.json({ error: "Range がファイルの大きさを超えています" }, { status: 416 });
    }
    const driveStatus = (err as { response?: { status?: number } })?.response?.status;
    if (driveStatus === 404) {
      return NextResponse.json({ error: "Drive にファイルがありません" }, { status: 404 });
    }
    if (driveStatus === 416) {
      return NextResponse.json({ error: "Range がファイルの大きさを超えています" }, { status: 416 });
    }
    console.error("[faces] 元ファイルの取得に失敗:", err);
    return NextResponse.json({ error: "元ファイルの取得に失敗しました" }, { status: 502 });
  }
}
