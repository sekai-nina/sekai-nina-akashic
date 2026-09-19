/**
 * 口コミの trait(言われ方)の表記ゆれを寄せる(可愛らしい → 可愛い 等)。
 *
 * 対応表は src/lib/domain/testimonial-traits.ts。表を増やしたらこれを流す。
 * status を問わず全件に掛ける(却下分も、再抽出の重複判定や語彙の集計で見るため)。
 *
 * Usage:
 *   pnpm cli:normalize-traits [--dry-run]
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { normalizeTrait } from "@/lib/domain/testimonial-traits";

// 既定の DATABASE_URL は RLS 有効の app_runtime ロールなので Testimonial が見えない。
// DIRECT_URL 未設定だと DATABASE_URL に無言でフォールバックするので先に止める
if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL が未設定です");
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const rows = await prisma.testimonial.findMany({ select: { id: true, trait: true } });
  const changes = rows
    .map((r) => ({ id: r.id, from: r.trait, to: normalizeTrait(r.trait) }))
    .filter((c) => c.from !== c.to);

  // 同じ書き換えはまとめて見せる
  const grouped = new Map<string, number>();
  for (const c of changes) {
    const key = `${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  console.log(`口コミ ${rows.length} 件中、寄せる trait: ${changes.length} 件${dryRun ? " (DRY RUN)" : ""}`);
  for (const [key, n] of [...grouped.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}  ×${n}`);
  }

  if (dryRun || changes.length === 0) return;

  let updated = 0;
  for (const c of changes) {
    await prisma.testimonial.update({ where: { id: c.id }, data: { trait: c.to } });
    updated++;
  }
  console.log(`更新: ${updated}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
