/**
 * 一度きりの後片付け: 素材のクリップ進捗 (`MaterialClipStatus`) のキーを URL から本文アセットに付け替える (#429)。
 *
 * URL 系ソース (ブログ・雑誌など) の素材は、URL ごとではなく本文アセット (kind=text) ごとに数えるようにした
 * (キーは `asset:<本文アセット id>`)。既存の済・手動対象は URL をキーにしているので、所属する本文アセットの
 * キーに移す。本文アセットの無い URL (インスタ・動画) は URL のままなので触らない。
 * 同じ本文アセットに移る行が複数あれば 1 行にまとめる (済・手動対象はどちらかが立っていれば立てる。機密は高いほう)。
 * トーク (日付キー) とラジオ (記事の行キー) は対象外。
 *
 * Usage:
 *   pnpm cli:rekey-material-clip-status            # 下見 (何もしない)
 *   pnpm cli:rekey-material-clip-status --apply    # 実行
 */
import type { ClearanceLevel, MaterialClipStatus } from "@prisma/client";
import { prismaInternal } from "@/lib/db";
import { isAboveClearance } from "@/lib/classification";
import { MATERIAL_SOURCE_KEYS, TEXT_ASSET_KEY_PREFIX, textAssetIdOfKey, textAssetKey } from "@/lib/clip-progress/material-items";
import { urlMaterials } from "@/lib/domain/material-clip-progress";

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.DIRECT_URL?.trim()) {
    console.error("DIRECT_URL が未設定です (prismaInternal が DATABASE_URL に無言でフォールバックする)");
    process.exit(1);
  }
  const sources = await prismaInternal.dataSource.findMany({
    where: { key: { in: [...MATERIAL_SOURCE_KEYS] }, itemRule: { in: ["blog_url", "source_url"] } },
  });

  await prismaInternal.$transaction(async (tx) => {
    for (const source of sources) {
      const rows = await tx.materialClipStatus.findMany({
        where: { dataSourceKey: source.key, NOT: { itemKey: { startsWith: TEXT_ASSET_KEY_PREFIX } } },
      });
      if (!rows.length) continue;
      const byUrl = await urlMaterials(tx, source, rows.map((r) => r.itemKey));
      const moves = new Map<string, MaterialClipStatus[]>();
      let unchanged = 0;
      for (const row of rows) {
        const target = byUrl.get(row.itemKey)?.key;
        if (!target || target === row.itemKey) { unchanged++; continue; }
        moves.set(target, [...(moves.get(target) ?? []), row]);
      }
      const existing = await tx.materialClipStatus.findMany({
        where: { dataSourceKey: source.key, itemKey: { in: [...moves.keys()] } },
      });
      const existingByKey = new Map(existing.map((e) => [e.itemKey, e]));
      // 移した先の本文アセットの機密も継承する (アプリの保存と同じく、状態行は素材より低い機密にしない)
      const targets = await tx.asset.findMany({
        where: { id: { in: [...moves.keys()].flatMap((k) => textAssetIdOfKey(k) ?? []) } },
        select: { id: true, classification: true },
      });
      const targetClassification = new Map(targets.map((t) => [textAssetKey(t.id), t.classification]));
      console.log(`${source.key}: ${rows.length} 行のうち ${rows.length - unchanged} 行を ${moves.size} 件の本文アセットへ移す (URL のまま ${unchanged} 行)`);

      for (const [target, olds] of moves) {
        const keep = existingByKey.get(target);
        const all = keep ? [keep, ...olds] : olds;
        const classification = [source.classification, targetClassification.get(target), ...all.map((r) => r.classification)]
          .filter((c): c is ClearanceLevel => !!c)
          .reduce((max, c) => (isAboveClearance(c, max) ? c : max));
        const latest = [...all].sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime())[0];
        const data = {
          itemKey: target, done: all.some((r) => r.done), included: all.some((r) => r.included),
          classification, updatedById: latest.updatedById,
        };
        const [first, ...rest] = keep ? [keep, ...olds] : olds;
        console.log(`  ${olds.map((o) => o.itemKey).join(", ")} → ${target}${keep ? " (既存の行にまとめる)" : ""} 済=${data.done} 機密=${classification}`);
        if (!APPLY) continue;
        // 消すのは同じ本文アセットにまとめた残りの行だけ (id で指定)
        const restIds = rest.map((r) => r.id);
        if (restIds.length) await tx.materialClipStatus.deleteMany({ where: { id: { in: restIds } } });
        await tx.materialClipStatus.update({ where: { id: first.id }, data });
      }
    }
  }, { timeout: 60_000 });

  console.log(APPLY ? "付け替えました" : "下見のみ。--apply で実行する");
}

main()
  .catch((error) => { console.error(error); process.exit(1); })
  .finally(() => prismaInternal.$disconnect());
