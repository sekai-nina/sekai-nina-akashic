import { NextResponse } from "next/server";
import sharp from "sharp";
import { auth } from "@/lib/auth";
import { isR2Configured, uploadToR2 } from "@/lib/r2";
import { updateSketchSetting } from "@/lib/domain/sketch-setting";

/**
 * 画風の見本を差し替える (#136)。
 *
 * **Server Action ではなく API route。** Server Action の本文は既定 1MB までで、
 * スケッチの画像は普通にそれを超える (`/api/upload` も同じ理由でここに置いてある)。
 */
export const maxDuration = 60;

/** 見本の長辺。1 枚しか使わないのでここまで小さくして持つ */
const MAX_EDGE = 1536;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isR2Configured()) {
    return NextResponse.json({ error: "R2 が未設定です" }, { status: 500 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "画像を選んでください" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "画像が大きすぎます (12MB まで)" }, { status: 400 });
  }

  let png: Buffer;
  try {
    png = await sharp(Buffer.from(await file.arrayBuffer()))
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    return NextResponse.json({ error: "画像として読めませんでした" }, { status: 400 });
  }

  // **毎回あたらしい key に置く。** R2 は immutable で配るので、同じ key に上書きすると
  // 画面にいつまでも古い画像が出る
  const key = `meetgreet/style-reference/${Date.now()}.png`;
  await uploadToR2(key, png, "image/png");
  const setting = await updateSketchSetting({ styleReferenceKey: key }, session.user.id);
  return NextResponse.json({ styleReferenceUrl: setting.styleReferenceUrl });
}
