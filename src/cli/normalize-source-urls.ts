/**
 * SourceRecord.url の前後の空白・改行を取り除く。
 *
 * URL 検索は完全一致で引く（RLS 下でも速いのは leakproof な `=` だけ）ため、
 * 前後に空白が残っていると引っかからない。
 *
 * Usage:
 *   pnpm cli:normalize-source-urls [--dry-run]
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// 既定の DATABASE_URL は RLS 有効の app_runtime ロールなので、
// SourceRecord が見えない。CLI は DIRECT_URL (postgres) で繋ぐ。
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const rows = await prisma.$queryRaw<Array<{ id: string; url: string }>>`
    SELECT "id", "url" FROM "SourceRecord"
    WHERE "url" IS NOT NULL AND "url" <> btrim("url", E' \\t\\r\\n')
  `;

  console.log(`前後に空白がある URL: ${rows.length} 件${dryRun ? " (DRY RUN)" : ""}`);
  for (const row of rows.slice(0, 5)) {
    console.log(`  ${JSON.stringify(row.url)} → ${JSON.stringify(row.url.trim())}`);
  }
  if (rows.length > 5) console.log(`  ... 他 ${rows.length - 5} 件`);

  if (dryRun || rows.length === 0) return;

  let updated = 0;
  for (const row of rows) {
    const trimmed = row.url.trim();
    if (!trimmed) continue;
    await prisma.sourceRecord.update({ where: { id: row.id }, data: { url: trimmed } });
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
