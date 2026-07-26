/**
 * src/lib/members.ts の名簿を Entity.generation / Entity.reading に反映する。
 *
 * 何度流しても同じ結果になる。メンバーの増減があれば members.ts を直して
 * 流し直す。
 *
 * Usage:
 *   pnpm cli:sync-members [--dry-run]
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { findMember, MEMBERS, normalizeMemberName } from "../lib/members";

// 既定の DATABASE_URL は RLS 有効の app_runtime ロールなので、
// AssetEntity などが見えない。CLI は DIRECT_URL (postgres) で繋ぐ。
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const dryRun = process.argv.includes("--dry-run");

async function main() {
  console.log(`メンバー名簿を Entity に反映${dryRun ? " (DRY RUN)" : ""}`);

  const persons = await prisma.entity.findMany({
    where: { type: "person" },
    select: { id: true, canonicalName: true, generation: true, reading: true },
    orderBy: { canonicalName: "asc" },
  });

  let updated = 0;
  let unchanged = 0;
  const unmatched: string[] = [];

  for (const person of persons) {
    const member = findMember(person.canonicalName);
    if (!member) {
      unmatched.push(person.canonicalName);
      continue;
    }
    if (person.generation === member.generation && person.reading === member.reading) {
      unchanged++;
      continue;
    }
    console.log(
      `  ${person.canonicalName}: generation=${member.generation} reading=${member.reading}`
    );
    if (!dryRun) {
      await prisma.entity.update({
        where: { id: person.id },
        data: { generation: member.generation, reading: member.reading },
      });
    }
    updated++;
  }

  // 名簿にいるのに Entity が無いメンバー（まだ登場していない等）
  const existing = new Set(persons.map((p) => normalizeMemberName(p.canonicalName)));
  const missing = MEMBERS.filter((m) => !existing.has(normalizeMemberName(m.name)));

  console.log(`\n更新: ${updated} / 変更なし: ${unchanged}`);
  if (unmatched.length > 0) {
    console.log(`名簿に無い person エンティティ (${unmatched.length}): ${unmatched.join(", ")}`);
  }
  if (missing.length > 0) {
    console.log(`エンティティが無いメンバー (${missing.length}): ${missing.map((m) => m.name).join(", ")}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
