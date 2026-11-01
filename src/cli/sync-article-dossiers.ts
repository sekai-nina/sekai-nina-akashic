/**
 * 全記事の出典を記事の企画に突き合わせ、企画に無いものを足す (#337)。
 *
 * 出典を足す経路はコミット後に企画へ写すが、そこが失敗したときや、経路の外で出典を書いたときの
 * 取りこぼしを直す。中身は `syncArticleSourcesToDossier` (冪等) を全記事に回すだけ。
 * 企画の無い記事は企画を作る (所有者は --owner か、admin が 1 人ならその人)。
 *
 * 外した出典の片付けはしない (外した行はもう無く、企画のどのアイテムが写しだったか分からない)。
 *
 * **人が企画から消したアイテムも、記事に出典が残っていれば足し戻す。** 下見の一覧を見て、
 * 消したばかりの企画が載っていないか確かめてから --apply する。
 *
 * 書き込みは DIRECT_URL (RLS バイパス)。既定は下見、--apply で書く。
 *
 * Usage:
 *   pnpm cli:sync-article-dossiers                         # 下見
 *   pnpm cli:sync-article-dossiers --apply [--owner <email>]
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { syncArticleSourcesToDossier } from "@/lib/domain/article-dossier-sync";

if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL が未設定です (このスクリプトは RLS バイパス接続が必須)");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ownerEmail = (() => {
  const i = args.indexOf("--owner");
  return i >= 0 ? args[i + 1] : undefined;
})();

async function main() {
  let ownerId: string | null = null;
  if (ownerEmail) {
    const u = await prisma.user.findUnique({ where: { email: ownerEmail }, select: { id: true } });
    if (!u) throw new Error(`--owner のユーザーが見つかりません: ${ownerEmail}`);
    ownerId = u.id;
  }
  console.log(`記事の出典を企画に突き合わせ (${APPLY ? "書き込み" : "下見。書くには --apply"})`);

  const articles = await prisma.article.findMany({ select: { id: true, path: true }, orderBy: { path: "asc" } });
  const totals = { articles: 0, added: 0, created: 0, linked: 0, skippedAbove: 0, noOwner: 0 };
  for (const a of articles) {
    const r = await syncArticleSourcesToDossier(prisma, a.id, { ownerId, apply: APPLY });
    if (r.noOwner) {
      totals.noOwner++;
      console.log(`  [所有者なし] ${a.path}: 企画を作れない (--owner を付ける)`);
      continue;
    }
    // 素材になる出典が無い記事 (none) と、揃っている記事は出さない。機密で足せないだけの記事も
    // 毎回同じ行が出るので数えない (見送りの件数だけ合計に足す)
    if (!r.added && (r.dossier === "existing" || r.dossier === "none")) {
      totals.skippedAbove += r.skippedAbove;
      continue;
    }
    totals.articles++;
    totals.added += r.added;
    totals.skippedAbove += r.skippedAbove;
    if (r.dossier === "created") totals.created++;
    if (r.dossier === "linked") totals.linked++;
    const head = r.dossier === "created" ? "[企画を作成] " : r.dossier === "linked" ? "[ミーグリの企画にリンク] " : "";
    console.log(`  ${head}${a.path}: +${r.added}${r.skippedAbove ? ` (企画より機密が上で見送り ${r.skippedAbove})` : ""}`);
  }
  console.log(
    `\n記事 ${articles.length} 件 / 直す記事 ${totals.articles} (企画を作成 ${totals.created}、リンク ${totals.linked}) / ` +
      `足す素材 ${totals.added} / 機密で見送り ${totals.skippedAbove} / 所有者なし ${totals.noOwner}`
  );
  if (!APPLY) console.log("下見でした。書き込むには --apply");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
