/**
 * 保存期間を過ぎた案内AIの質問ログを消す。
 *
 * 公開している方針文(/ai)で「最大180日間保存」と約束しているので、
 * これを守るための処理。日次で回す想定。
 *
 * 使い方:
 *   pnpm tsx scripts/purge-ai-questions.ts            # 消す
 *   pnpm tsx scripts/purge-ai-questions.ts --dry-run  # 件数だけ見る
 */

import "dotenv/config";
import { withClearance } from "@/lib/db";
import { purgeExpiredAiQuestions, RETENTION_DAYS } from "@/lib/domain/ai-questions";

const DRY_RUN = process.argv.includes("--dry-run");
// RLS は fail-closed なので、全行に届くクリアランスで実行する
const CLEARANCE = "restricted";

async function main() {
  const expired = await withClearance(CLEARANCE, (tx) =>
    tx.aiQuestion.count({ where: { expiresAt: { lt: new Date() } } })
  );

  console.log(`保存期間: ${RETENTION_DAYS}日 / 期限切れ: ${expired}件`);

  if (DRY_RUN) {
    console.log("--dry-run のため削除しません。");
    return;
  }
  if (expired === 0) return;

  const deleted = await purgeExpiredAiQuestions(CLEARANCE);
  console.log(`${deleted}件削除しました。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.$disconnect();
  });
