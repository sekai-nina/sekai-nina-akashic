import { NextResponse } from "next/server";
import sharp from "sharp";
import { auth } from "@/lib/auth";
import { isR2Configured, uploadToR2 } from "@/lib/r2";
import { getMeetGreet, MeetGreetInputError } from "@/lib/domain/meetgreets";
import { addSketchRef, removeSketchRef } from "@/lib/domain/meetgreet-sketch";
import { refPrefix } from "@/lib/meetgreet/sketch-refs";

type Params = { params: Promise<{ id: string }> };

/**
 * その回だけの参考画像 (#159)。
 *
 * **Server Action ではなく API route。** Server Action の本文は既定 1MB までで、
 * 写真は普通にそれを超える (`/api/upload` も同じ理由でここに置いてある)。
 *
 * アセットにもドシエにも入れない。R2 に置いて `MeetGreet.sketchRefs` に key を覚えるだけ。
 */
export const maxDuration = 60;

/** 参照に使うだけなので、原本の解像度は要らない */
const MAX_EDGE = 1600;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function POST(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isR2Configured()) {
    return NextResponse.json({ error: "R2 が未設定です" }, { status: 500 });
  }

  const { id } = await params;
  const mg = await getMeetGreet(session.user, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "画像を選んでください" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "画像が大きすぎます (20MB まで)" }, { status: 400 });
  }

  let webp: Buffer;
  try {
    // **ここで正立にしておく。** 画面で枠を引くのも切り出す元もこの 1 枚になるので、
    // 向きが揃っていれば切り抜きの座標系で悩まない (#136 で踏んだ穴)
    webp = await sharp(Buffer.from(await file.arrayBuffer()))
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();
  } catch {
    return NextResponse.json({ error: "画像として読めませんでした" }, { status: 400 });
  }

  const key = `${refPrefix(id)}/${Date.now()}.webp`;
  await uploadToR2(key, webp, "image/webp");
  try {
    const refs = await addSketchRef(session.user, mg, {
      key,
      name: file.name || "参考画像",
    });
    return NextResponse.json({ refs });
  } catch (e) {
    if (e instanceof MeetGreetInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!key) return NextResponse.json({ error: "key が必要です" }, { status: 400 });

  const mg = await getMeetGreet(session.user, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const refs = await removeSketchRef(session.user, mg, key);
    return NextResponse.json({ refs });
  } catch (e) {
    if (e instanceof MeetGreetInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
