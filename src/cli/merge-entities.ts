/**
 * 重複したエンティティを1つにまとめる。
 *
 * --from のエンティティに紐づくアセット/口コミ/ライブ/顔認識の結果を --to へ付け替えてから --from を消す。
 * 付け替え先に既に同じアセットの紐づきがある場合は重複行を消す。そのとき --from 側に人が付けた
 * roleLabel (author / subject 等) があり、--to 側が空か顔認識の自動付与 (face) なら、--to 側に移す
 * (`mergedRoleLabel`)。別名は両方を合わせ、--from の名前も別名に足す。
 *
 * 聖地 (place) は Entity が消えると Place も消える (onDelete: Cascade)。--from の Place に
 * 企画の場所候補・記事の訪問が付いていれば、消えてしまうので止める。
 *
 * Usage:
 *   pnpm cli:merge-entities --from <entityId> --to <entityId> [--dry-run]
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { NINA_ENTITY_ID } from "@/lib/nina";
import { mergedRoleLabel } from "@/lib/role-label";

// 既定の DATABASE_URL は RLS 有効の app_runtime ロールなので、
// AssetEntity などが見えない。CLI は DIRECT_URL (RLS バイパス) で繋ぐ。
// DIRECT_URL が無いと型エラーにならずに DATABASE_URL へ無言で落ちるので先に止める
if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL が未設定です");
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const dryRun = process.argv.includes("--dry-run");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const fromId = argValue("--from");
  const toId = argValue("--to");
  if (!fromId || !toId) {
    console.error("Usage: pnpm cli:merge-entities --from <entityId> --to <entityId> [--dry-run]");
    process.exitCode = 1;
    return;
  }
  if (fromId === toId) {
    console.error("--from と --to が同じです");
    process.exitCode = 1;
    return;
  }

  const [from, to] = await Promise.all([
    prisma.entity.findUnique({
      where: { id: fromId },
      select: {
        id: true,
        type: true,
        canonicalName: true,
        aliases: true,
        place: { select: { id: true, _count: { select: { dossierCandidates: true, articles: true } } } },
        _count: { select: { assets: true, testimonials: true } },
      },
    }),
    prisma.entity.findUnique({
      where: { id: toId },
      select: {
        id: true,
        type: true,
        canonicalName: true,
        aliases: true,
        place: { select: { id: true, _count: { select: { dossierCandidates: true, articles: true } } } },
        _count: { select: { assets: true, testimonials: true } },
      },
    }),
  ]);
  if (!from || !to) {
    console.error(`エンティティが見つかりません: ${!from ? fromId : toId}`);
    process.exitCode = 1;
    return;
  }
  if (from.type !== to.type) {
    console.error(`型が違います: ${from.type} → ${to.type}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `統合${dryRun ? " (DRY RUN)" : ""}: 「${from.canonicalName}」(アセット${from._count.assets}/口コミ${from._count.testimonials})` +
      ` → 「${to.canonicalName}」(アセット${to._count.assets}/口コミ${to._count.testimonials})`
  );

  if (from.place && (from.place._count.dossierCandidates > 0 || from.place._count.articles > 0)) {
    console.error(
      `「${from.canonicalName}」の聖地に企画の場所候補 ${from.place._count.dossierCandidates} 件・記事 ${from.place._count.articles} 件が付いています。` +
        "統合すると消えるので、--from と --to を入れ替えるか、先に付け替えてください"
    );
    process.exitCode = 1;
    return;
  }

  const links = await prisma.assetEntity.findMany({
    where: { entityId: fromId },
    select: { id: true, assetId: true, roleLabel: true },
  });
  const existing = new Map(
    (
      await prisma.assetEntity.findMany({
        where: { entityId: toId, assetId: { in: links.map((l) => l.assetId) } },
        select: { id: true, assetId: true, roleLabel: true },
      })
    ).map((l) => [l.assetId, l])
  );

  const moved = links.filter((l) => !existing.has(l.assetId));
  const duplicated = links.filter((l) => existing.has(l.assetId));
  // 重複のうち、残す側の roleLabel を人が付けた値に書き換えるもの
  const roleUpdates = duplicated.flatMap((l) => {
    const target = existing.get(l.assetId)!;
    const roleLabel = mergedRoleLabel(target.roleLabel, l.roleLabel);
    return roleLabel === undefined ? [] : [{ id: target.id, from: target.roleLabel, roleLabel }];
  });
  console.log(
    `  アセット: 付け替え ${moved.length} / 重複のため削除 ${duplicated.length} (うち残す側の役割を書き換え ${roleUpdates.length}` +
      `${roleUpdates.length > 0 ? `: ${[...new Set(roleUpdates.map((u) => `${u.from ?? "(空)"}→${u.roleLabel}`))].join(", ")}` : ""})`
  );

  const [testimonials, lives, facePredicted, faceConfirmed] = await Promise.all([
    prisma.testimonial.count({ where: { entityId: fromId } }),
    prisma.live.count({ where: { entityId: fromId } }),
    prisma.faceDetection.count({ where: { predictedEntityId: fromId } }),
    prisma.faceDetection.count({ where: { confirmedEntityId: fromId } }),
  ]);
  console.log(`  口コミ: 付け替え ${testimonials} / ライブ: 付け替え ${lives} / 顔認識: 推定 ${facePredicted}・確認 ${faceConfirmed}`);

  // 別名は両方を合わせ、消える側の名前も足す (表記ゆれで探されたときに当たるように)
  const aliasesOf = (v: unknown) => (Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : []);
  const aliases = [...new Set([...aliasesOf(to.aliases), ...aliasesOf(from.aliases), from.canonicalName])].filter(
    (a) => a !== to.canonicalName
  );
  const addedAliases = aliases.filter((a) => !aliasesOf(to.aliases).includes(a));
  console.log(`  別名: 追加 ${addedAliases.length}${addedAliases.length > 0 ? ` (${addedAliases.join(", ")})` : ""}`);
  if (from.place) console.log(`  聖地: 「${from.canonicalName}」の Place を消す (場所候補・記事は 0 件)`);

  if (dryRun) return;

  await prisma.$transaction([
    ...moved.map((l) =>
      prisma.assetEntity.update({ where: { id: l.id }, data: { entityId: toId } })
    ),
    ...(duplicated.length > 0
      ? [prisma.assetEntity.deleteMany({ where: { id: { in: duplicated.map((l) => l.id) } } })]
      : []),
    // 坂井新奈へ統合したら、付け替えたアセットの「出ていない」を外す (両立させない。#261)
    ...(toId === NINA_ENTITY_ID && moved.length > 0
      ? [prisma.asset.updateMany({ where: { id: { in: moved.map((l) => l.assetId) }, ninaAbsent: true }, data: { ninaAbsent: false } })]
      : []),
    ...roleUpdates.map((u) => prisma.assetEntity.update({ where: { id: u.id }, data: { roleLabel: u.roleLabel } })),
    ...(testimonials > 0
      ? [prisma.testimonial.updateMany({ where: { entityId: fromId }, data: { entityId: toId } })]
      : []),
    ...(lives > 0 ? [prisma.live.updateMany({ where: { entityId: fromId }, data: { entityId: toId } })] : []),
    // 消すと SetNull で顔認識の結果が宙に浮くので付け替える
    ...(facePredicted > 0
      ? [prisma.faceDetection.updateMany({ where: { predictedEntityId: fromId }, data: { predictedEntityId: toId } })]
      : []),
    ...(faceConfirmed > 0
      ? [prisma.faceDetection.updateMany({ where: { confirmedEntityId: fromId }, data: { confirmedEntityId: toId } })]
      : []),
    ...(addedAliases.length > 0 ? [prisma.entity.update({ where: { id: toId }, data: { aliases } })] : []),
    prisma.entity.delete({ where: { id: fromId } }),
  ]);

  console.log("完了");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
