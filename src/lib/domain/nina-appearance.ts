/**
 * アセットに坂井新奈が出ているか (#261) の付け外し。3 状態の定義は src/lib/nina.ts。
 *
 * 「出ていない」を AssetEntity に混ぜないのは、エンティティ検索・MCP の「坂井新奈」絞り込みが
 * 「紐づいている = 関係がある」前提だから。両立させないよう、出演の切り替えはここを通し、
 * 坂井新奈を紐づける他の経路 (updateAsset / addEntityToAsset) は clearNinaAbsentIfLinking を呼ぶ。
 */
import type { TransactionClient } from "@/lib/db";
import { withClearance } from "@/lib/db";
import { backupAssetToDrive } from "@/lib/drive";
import { NINA_ENTITY_ID, ninaAppearanceOf, type NinaAppearance } from "@/lib/nina";
import { logAudit } from "./audit";

/** 本人が著者のアセット (ブログ・本人の投稿) は「出ている」以外にできない */
export class NinaAuthorConflictError extends Error {
  constructor() {
    super("坂井新奈が著者 (author) のアセットは「出ていない」「未確認」にできません");
  }
}

/** 坂井新奈を紐づけるなら「出ていない」を外す。紐づけと同じトランザクションで呼ぶ */
export async function clearNinaAbsentIfLinking(tx: TransactionClient, assetId: string, entityIds: string[]) {
  if (!entityIds.includes(NINA_ENTITY_ID)) return;
  await tx.asset.updateMany({ where: { id: assetId, ninaAbsent: true }, data: { ninaAbsent: false } });
}

/**
 * 3 状態のどれかに置く。アセットが見えない (無い・クリアランス外) なら null。
 * 既に「出ている」ものを appears にしても roleLabel は変えない (「author」を「出演」で潰さない)
 */
export async function setNinaAppearance(
  assetId: string,
  status: NinaAppearance,
  userId: string | null,
  clearance: string
): Promise<NinaAppearance | null> {
  const result = await withClearance(clearance, async (tx) => {
    // bot の ✅ / ❌ と画面の操作が同時に来ても両方立たないよう、Asset の行をロックしてから読む。
    // RLS 下なので見えない行は 0 件になる
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Asset" WHERE id = ${assetId} FOR UPDATE`;
    if (locked.length === 0) return null;
    const asset = await tx.asset.findUniqueOrThrow({
      where: { id: assetId },
      select: { ninaAbsent: true, entities: { where: { entityId: NINA_ENTITY_ID }, select: { entityId: true, roleLabel: true } } },
    });
    const before = ninaAppearanceOf(asset);
    const link = asset.entities[0];

    if (status === "appears") {
      if (!link) {
        // 画面のエンティティ追加など、行ロックを取らない経路と重なっても一意制約で落とさない
        await tx.assetEntity.createMany({
          data: [{ assetId, entityId: NINA_ENTITY_ID, roleLabel: "出演" }],
          skipDuplicates: true,
        });
      }
    } else if (link) {
      if (link.roleLabel === "author") throw new NinaAuthorConflictError();
      await tx.assetEntity.deleteMany({ where: { assetId, entityId: NINA_ENTITY_ID } });
    }
    const ninaAbsent = status === "absent";
    if (asset.ninaAbsent !== ninaAbsent) {
      await tx.asset.update({ where: { id: assetId }, data: { ninaAbsent, updatedById: userId } });
    }
    return { before };
  });
  if (!result) return null;

  if (result.before !== status) {
    await logAudit({
      actorId: userId,
      action: "asset.nina_appearance",
      targetType: "Asset",
      targetId: assetId,
      metadata: { from: result.before, to: status },
    });
    // Drive のバックアップに出演の状態も載っているので更新する (updateAsset と同じく非同期)
    backupAssetToDrive(assetId).catch((err) => console.error("Asset backup to Drive failed:", err));
  }
  return status;
}
