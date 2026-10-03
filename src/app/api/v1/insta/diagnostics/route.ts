/**
 * story パイプラインの足回りの自己診断 (#206)。
 *
 * ffmpeg は **バンドルに含め忘れると実行時に初めて落ちる**（`isTranscodeAvailable()` は
 * パス文字列しか見ないので true のまま）。story を待たずに確かめられる口を用意する。
 */
import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ffmpegDiagnostics } from "@/lib/insta/transcode";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, ["read", "insta_worker"]);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ ffmpeg: await ffmpegDiagnostics() });
}
