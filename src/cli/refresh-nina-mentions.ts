/**
 * Asset.mentionsNina (本文が坂井新奈に言及しているか) を付け直す。
 *
 * 普段は 15 分ごとの cron (/api/cron/nina-mentions) が同じ処理を回す。これは初回の埋め込みと、
 * 別名を足したあとに結果を下見するためのもの。
 *
 * Usage:
 *   pnpm cli:refresh-nina-mentions            # 下見 (何もしない)
 *   pnpm cli:refresh-nina-mentions --apply    # 書き込む
 */
import { prismaInternal } from "@/lib/db";
import { refreshNinaMentions } from "@/lib/domain/nina-mentions";

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.DIRECT_URL?.trim()) {
    console.error("DIRECT_URL が未設定です (prismaInternal が DATABASE_URL に無言でフォールバックする)");
    process.exit(1);
  }
  const result = await refreshNinaMentions(prismaInternal, { apply: APPLY });
  console.log(`一致語 ${result.terms.length} 語: ${result.terms.join(" / ")}`);
  console.log(`本文が一致 ${result.matched} 件: 付ける ${result.added.length} 件 / 外す ${result.removed.length} 件`);
  const sample = await prismaInternal.asset.findMany({
    where: { id: { in: [...result.added.slice(0, 5), ...result.removed.slice(0, 5)] } },
    select: { id: true, kind: true, title: true },
  });
  for (const a of sample) console.log(`  ${result.added.includes(a.id) ? "+" : "-"} ${a.kind} ${a.title.slice(0, 60)} (${a.id})`);
  console.log(APPLY ? "書き込みました" : "下見のみ。--apply で書き込む");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prismaInternal.$disconnect());
