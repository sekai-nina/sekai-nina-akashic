import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { auth } from "@/lib/auth";
import { accessibleClassifications } from "@/lib/classification";
import { MAX_EXTERNAL_AI_CLEARANCE } from "@/lib/meetgreet/config";
import { deleteFromR2, isR2Configured, uploadToR2 } from "@/lib/r2";
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

/**
 * 参照に使うだけなので原本の解像度は要らない。
 * 生成側も 1280px に縮めて送る (`REFERENCE_MAX_EDGE`) ので、それより大きく持っても捨てるだけ。
 */
const MAX_EDGE = 1280;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** 展開後の画素数の上限 (小さいファイルで巨大な画像を作られて時間とメモリを食われないように) */
const MAX_INPUT_PIXELS = 50_000_000;

export async function POST(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // **member 以上に限る。** 画面の Server Action (`requireMember`) と揃える。
  // ここは外部 AI に送る材料を置く口なので、読むだけの人に開けない
  if (!["admin", "member"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isR2Configured()) {
    return NextResponse.json({ error: "R2 が未設定です" }, { status: 500 });
  }

  const { id } = await params;
  const mg = await getMeetGreet(session.user, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // **生成できない回には置かせない。** 置いた時点で公開 URL の R2 に載るので、
  // 「生成のときに断る」では遅い (#159)
  const allowed: readonly string[] = accessibleClassifications(MAX_EXTERNAL_AI_CLEARANCE);
  if (!allowed.includes(mg.classification)) {
    return NextResponse.json(
      { error: "この回は機密レベルが高いため、参考画像を置けません" },
      { status: 400 }
    );
  }

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
    webp = await sharp(Buffer.from(await file.arrayBuffer()), {
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();
  } catch {
    return NextResponse.json({ error: "画像として読めませんでした" }, { status: 400 });
  }

  // **同じミリ秒に 2 枚上がると上書きになる**ので、時刻ではなく乱数で分ける
  const key = `${refPrefix(id)}/${randomUUID()}.webp`;
  await uploadToR2(key, webp, "image/webp");
  try {
    const refs = await addSketchRef(session.user, mg, {
      key,
      name: file.name || "参考画像",
    });
    return NextResponse.json({ refs });
  } catch (e) {
    // **覚えられなかったら実体も消す。** 残すと、誰も参照していないのに公開 URL で
    // 開ける画像がバケットに溜まり続ける (immutable で配るので消す手段も無くなる)
    await deleteFromR2(key).catch(() => {});
    if (e instanceof MeetGreetInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "member"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
