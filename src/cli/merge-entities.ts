/**
 * 重複したエンティティを1つにまとめる。
 *
 * --from のエンティティに紐づくアセット/口コミを --to へ付け替えてから --from を消す。
 * 付け替え先に既に同じ組み合わせがある場合は、重複行を消すだけにする。
 *
 * Usage:
 *   pnpm cli:merge-entities --from <entityId> --to <entityId> [--dry-run]
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// 既定の DATABASE_URL は RLS 有効の app_runtime ロールなので、
// AssetEntity などが見えない。CLI は DIRECT_URL (postgres) で繋ぐ。
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
      select: { id: true, type: true, canonicalName: true, _count: { select: { assets: true, testimonials: true } } },
    }),
    prisma.entity.findUnique({
      where: { id: toId },
      select: { id: true, type: true, canonicalName: true, _count: { select: { assets: true, testimonials: true } } },
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

  const links = await prisma.assetEntity.findMany({
    where: { entityId: fromId },
    select: { id: true, assetId: true, roleLabel: true },
  });
  const existing = new Set(
    (
      await prisma.assetEntity.findMany({
        where: { entityId: toId, assetId: { in: links.map((l) => l.assetId) } },
        select: { assetId: true },
      })
    ).map((l) => l.assetId)
  );

  const moved = links.filter((l) => !existing.has(l.assetId));
  const duplicated = links.filter((l) => existing.has(l.assetId));
  console.log(`  アセット: 付け替え ${moved.length} / 重複のため削除 ${duplicated.length}`);

  const testimonials = await prisma.testimonial.findMany({
    where: { entityId: fromId },
    select: { id: true },
  });
  console.log(`  口コミ: 付け替え ${testimonials.length}`);

  if (dryRun) return;

  await prisma.$transaction([
    ...moved.map((l) =>
      prisma.assetEntity.update({ where: { id: l.id }, data: { entityId: toId } })
    ),
    ...(duplicated.length > 0
      ? [prisma.assetEntity.deleteMany({ where: { id: { in: duplicated.map((l) => l.id) } } })]
      : []),
    ...(testimonials.length > 0
      ? [prisma.testimonial.updateMany({ where: { entityId: fromId }, data: { entityId: toId } })]
      : []),
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
