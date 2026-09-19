import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withSession } from "@/lib/db";
import { classificationFilter } from "@/lib/classification";
import { getMeetGreet } from "@/lib/domain/meetgreets";
import { MAX_EXTERNAL_AI_CLEARANCE } from "@/lib/meetgreet/config";
import { loadAssetImage } from "@/lib/meetgreet/sketch";

type Params = { params: Promise<{ id: string; assetId: string }> };

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
export const maxDuration = 60;

export async function GET(_request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, assetId } = await params;
  const mg = await getMeetGreet(session.user, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // **ドシエにある internal 以下の画像だけ。** 枠を保存するときと同じ条件にしておかないと、
  // ここが「任意のアセットを見る」口になる
  const asset = await withSession(session.user, (tx) =>
    tx.asset.findFirst({
      where: {
        id: assetId,
        kind: "image",
        ...classificationFilter(MAX_EXTERNAL_AI_CLEARANCE),
        dossierItems: { some: { dossierId: mg.dossierId } },
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
