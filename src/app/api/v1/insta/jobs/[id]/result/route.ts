import { NextResponse } from "next/server";
import { z } from "zod";
import { registerStoryFile, type StoryFileSource } from "@/lib/domain/insta-jobs";
import { instaJobErrorResponse, instaJobToJson, requireInstaJobAuth } from "@/lib/insta/api";
import { DIRECT_UPLOAD_TOO_LARGE_MESSAGE, MAX_DIRECT_UPLOAD_BYTES } from "@/lib/insta/jobs";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

// Drive からの取得・SHA256・サムネイル生成を含む。動画 (数十 MB) でも 1 分に収める
export const maxDuration = 60;

const DriveBody = z
  .object({
    driveFileId: z.string().regex(/^[A-Za-z0-9_-]{10,}$/),
    filename: z.string().min(1).max(200),
    mimeType: z.string().max(100).optional().default(""),
    // 上限の判定はドメイン側 (413)。ここで弾くと 400 になって理由が分かりにくい
    fileSize: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * 落としたファイル 1 件の登録。ファイルの数だけ呼び、最後に `complete` を叩く。
 *
 * 2 通りの本文を受ける:
 * - `application/json`: `{ driveFileId, filename, mimeType, fileSize }` — `upload-url` で Drive に
 *   直接 PUT した後 (動画はこちら)
 * - `multipart/form-data`: `file` — 4MB までの小さい画像はこれで一発 (Vercel の本文上限のため)
 *
 * 1 件ごとに Asset を作る。同じ実体が既にあれば新しい Asset は作らず duplicate として記録する。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireInstaJobAuth(request, "worker");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const contentType = request.headers.get("content-type") ?? "";

  let source: StoryFileSource;
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ error: "invalid multipart body" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }
    if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
      return NextResponse.json({ error: DIRECT_UPLOAD_TOO_LARGE_MESSAGE }, { status: 413 });
    }
    source = {
      kind: "buffer",
      buffer: Buffer.from(await file.arrayBuffer()),
      filename: file.name || "story",
      mimeType: file.type || null,
    };
  } else {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const parsed = DriveBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    source = {
      kind: "drive",
      driveFileId: parsed.data.driveFileId,
      filename: parsed.data.filename,
      mimeType: parsed.data.mimeType || null,
      fileSize: parsed.data.fileSize ?? null,
    };
  }

  try {
    const res = await registerStoryFile(id, source, { id: auth.id, clearance: auth.clearance });
    return NextResponse.json({ ...instaJobToJson(res.job), file: res.file }, { status: 201 });
  } catch (e) {
    return instaJobErrorResponse(e);
  }
}
