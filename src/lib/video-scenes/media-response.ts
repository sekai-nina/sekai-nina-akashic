import { NextResponse } from "next/server";
import { downloadRangeFromDrive, getDriveFileMeta } from "@/lib/drive";
import { mediaRange, MEDIA_CHUNK_BYTES } from "./policy";

export async function sceneMediaResponse(request: Request, file: {
  storageKey: string | null; fileSize: number | null; mimeType: string | null;
}) {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" };
  if (!file.storageKey) return NextResponse.json({ error: "ファイルがありません" }, { status: 404, headers });
  try {
    const total = file.fileSize ?? (await getDriveFileMeta(file.storageKey))?.size ?? 0;
    const range = mediaRange(request.headers.get("range"), total);
    if (!range) return new NextResponse(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${total}` } });
    const part = await downloadRangeFromDrive(file.storageKey, range.start, range.end, { timeoutMs: 20_000 });
    if (!part || (part.total != null && part.total !== total) || part.body.length !== range.end - range.start + 1 || part.body.length > MEDIA_CHUNK_BYTES) {
      return NextResponse.json({ error: "ファイルを取得できませんでした" }, { status: 502, headers });
    }
    const partial = request.headers.has("range") || total > MEDIA_CHUNK_BYTES;
    return new NextResponse(new Uint8Array(part.body), { status: partial ? 206 : 200, headers: {
      ...headers, "Content-Type": file.mimeType ?? "application/octet-stream", "Content-Length": String(part.body.length),
      ...(partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${total}` } : {}),
    } });
  } catch {
    return NextResponse.json({ error: "ファイルの取得に失敗しました" }, { status: 502, headers });
  }
}
