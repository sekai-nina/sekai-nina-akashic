/**
 * その器だけの参考画像 (#159) のアップロード / 削除と、切り抜き枠用の画像の配信。
 * ミーグリ (`/api/meetgreets/[id]/…`) とライブ (`/api/lives/[id]/…`) の route が同じ処理を
 * 呼ぶ (#150)。器の読み方と書き込み先だけを引数で受ける。
 *
 * **Server Action ではなく API route。** Server Action の本文は既定 1MB までで、
 * 写真は普通にそれを超える (`/api/upload` も同じ理由でここに置いてある)。
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { withSession } from "@/lib/db";
import { accessibleClassifications, classificationFilter } from "@/lib/classification";
import { MAX_EXTERNAL_AI_CLEARANCE } from "@/lib/meetgreet/config";
import { deleteFromR2, isR2Configured, uploadToR2 } from "@/lib/r2";
import { addSketchRef, removeSketchRef, type SketchStore } from "@/lib/domain/sketch";
import { WorkflowInputError, type ActingUser } from "@/lib/domain/article-workflow";
import { loadAssetImage } from "@/lib/meetgreet/sketch";
import { refPrefix } from "@/lib/meetgreet/sketch-refs";

/**
 * 参照に使うだけなので原本の解像度は要らない。
 * 生成側も 1280px に縮めて送る (`REFERENCE_MAX_EDGE`) ので、それより大きく持っても捨てるだけ。
 */
const MAX_EDGE = 1280;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** 展開後の画素数の上限 (小さいファイルで巨大な画像を作られて時間とメモリを食われないように) */
const MAX_INPUT_PIXELS = 50_000_000;

export interface SketchRefOwner {
  id: string;
  dossierId: string;
  classification: string;
  sketchRefs: unknown;
  sketchCrops: unknown;
}

/** 参考画像を R2 に置いて器に覚えさせる */
export async function uploadSketchRef(
  request: Request,
  store: SketchStore,
  user: ActingUser,
  owner: SketchRefOwner
): Promise<NextResponse> {
  if (!isR2Configured()) {
    return NextResponse.json({ error: "R2 が未設定です" }, { status: 500 });
  }
  // **生成できない器には置かせない。** 置いた時点で公開 URL の R2 に載るので、
  // 「生成のときに断る」では遅い (#159)
  const allowed: readonly string[] = accessibleClassifications(MAX_EXTERNAL_AI_CLEARANCE);
  if (!allowed.includes(owner.classification)) {
    return NextResponse.json(
      { error: `この${store.noun}は機密レベルが高いため、参考画像を置けません` },
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
  const key = `${refPrefix(store.kind, owner.id)}/${randomUUID()}.webp`;
  await uploadToR2(key, webp, "image/webp");
  try {
    const refs = await addSketchRef(store, user, owner, { key, name: file.name || "参考画像" });
    return NextResponse.json({ refs });
  } catch (e) {
    // **覚えられなかったら実体も消す。** 残すと、誰も参照していないのに公開 URL で
    // 開ける画像がバケットに溜まり続ける (immutable で配るので消す手段も無くなる)
    await deleteFromR2(key).catch(() => {});
    if (e instanceof WorkflowInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}

export async function deleteSketchRef(
  request: Request,
  store: SketchStore,
  user: ActingUser,
  owner: SketchRefOwner
): Promise<NextResponse> {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!key) return NextResponse.json({ error: "key が必要です" }, { status: 400 });
  try {
    const refs = await removeSketchRef(store, user, owner, key);
    return NextResponse.json({ refs });
  } catch (e) {
    if (e instanceof WorkflowInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}

/**
 * 切り抜き枠を引くための画像 (#136)。
 *
 * **画面に出すのは「サーバーが実際に切る画像」そのもの。** サムネイルは出どころで
 * 向きが違う (R2 の webp は Exif を当てずに作るので生の画素、Drive のプロキシは
 * ブラウザが Exif を当てて正立で表示する)。どちらで枠を引いたかをサーバーは知れないので、
 * 枠がずれる。ここで `loadAssetImage` と同じものを返して、座標系を 1 つに揃える。
 *
 * Drive を叩くので速くはない。枠を引く画面でしか使わないぶん、短くキャッシュする。
 */
export async function serveSketchReference(
  user: ActingUser,
  owner: { dossierId: string },
  assetId: string
): Promise<NextResponse> {
  // **ドシエにある internal 以下の画像だけ。** 枠を保存するときと同じ条件にしておかないと、
  // ここが「任意のアセットを見る」口になる
  const asset = await withSession(user, (tx) =>
    tx.asset.findFirst({
      where: {
        id: assetId,
        kind: "image",
        ...classificationFilter(MAX_EXTERNAL_AI_CLEARANCE),
        dossierItems: { some: { dossierId: owner.dossierId } },
      },
      select: { id: true, storageProvider: true, storageKey: true, thumbnailUrl: true },
    })
  );
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const image = await loadAssetImage(asset);
  if (!image) return NextResponse.json({ error: "画像を取得できませんでした" }, { status: 502 });

  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.contentType,
      // 個人のドシエの画像なので private。枠を引く間だけ持てばよい
      "Cache-Control": "private, max-age=300",
    },
  });
}
