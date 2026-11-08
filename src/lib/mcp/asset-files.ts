import { prismaInternal, withClearance } from "@/lib/db";
import { generateAndUploadThumbnails } from "@/lib/thumbnails";

/**
 * ファイル本体を持つアセットを作る MCP ツール (`akashic_complete_upload` / `akashic_import_images`)
 * の共通処理。
 */

const DUPLICATE_SELECT = { id: true, title: true, classification: true, storageKey: true } as const;

/**
 * sha256 や storageKey が一致する既存アセットを探す。RLS をバイパスして全件から引くので、
 * 呼び出し側はキーのクリアランスを超えるものの ID を返さないこと (存在だけ伝える)。
 */
export async function findDuplicate(where: { sha256: string } | { storageKey: string }) {
  return prismaInternal.asset.findFirst({ where, select: DUPLICATE_SELECT });
}

/**
 * sha256 が一致する既存アセットを、見えるものを優先して探す。
 * sha256 は一意でないので、同じ画像が見えるものと見えないものの両方にあるとき、
 * 見えない方を引いて「つなげない」と返さないようにする。
 */
export async function findDuplicateVisibleFirst(sha256: string, clearance: string) {
  const visible = await withClearance(clearance, (tx) =>
    tx.asset.findFirst({ where: { sha256 }, select: DUPLICATE_SELECT })
  );
  return visible ?? findDuplicate({ sha256 });
}

/**
 * 画像の R2 サムネイルを作って thumbnailUrl を差し替える。失敗してもアセットは残す
 * (generateAndUploadThumbnails は自分で失敗を握りつぶすので、ここで受けるのは DB の更新)。
 */
export async function attachR2Thumbnail(assetId: string, buffer: Buffer, clearance: string): Promise<void> {
  try {
    const r2Url = await generateAndUploadThumbnails(assetId, buffer);
    if (r2Url) {
      await withClearance(clearance, (tx) =>
        tx.asset.update({ where: { id: assetId }, data: { thumbnailUrl: r2Url } })
      );
    }
  } catch (err) {
    console.error("[mcp] R2 サムネイル生成に失敗:", err);
  }
}
