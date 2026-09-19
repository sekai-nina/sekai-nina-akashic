/**
 * Worker の KV に溜まっていた質問ログを Akashic に取り込む。
 *
 * Akashic への送信を入れる前の質問は KV にしか無い。それを一度だけ持ってくるためのもの。
 * 同じ質問（askedAt + question が一致）は入れ直さないので、何度流しても増えない。
 *
 * KV のログには出典の「件数」しか無く、どの記事だったかは残っていない。
 * そのため citations は空のまま、citationCount だけを埋める（画面では「内訳なし」と出る）。
 *
 * 書き出し方:
 *   wrangler kv key list --binding AI_KV --remote --prefix "log:"   # キー一覧
 *   wrangler kv key get  --binding AI_KV --remote "<key>"           # 1件ずつ
 *   → [{ts, question, answer, citation_count, cached, type}] の JSON にまとめる
 *
 * 使い方:
 *   pnpm tsx scripts/import-kv-ai-questions.ts <file.json> [--dry-run]
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { prisma, withClearance } from "@/lib/db";
import { expiryFor } from "@/lib/domain/ai-questions";

interface KvLog {
  ts: string;
  question: string;
  answer: string;
  citation_count?: number;
  cached?: boolean;
}

const file = process.argv[2];
const DRY_RUN = process.argv.includes("--dry-run");
// RLS は fail-closed なので、全行に届くクリアランスで実行する
const CLEARANCE = "restricted";

if (!file) {
  console.error("使い方: pnpm tsx scripts/import-kv-ai-questions.ts <file.json> [--dry-run]");
  process.exit(1);
}

async function main() {
  const logs = JSON.parse(readFileSync(file, "utf-8")) as KvLog[];
  console.log(`${logs.length}件を読み込みました`);

  let added = 0;
  let skipped = 0;

  for (const log of logs) {
    const askedAt = new Date(log.ts);
    if (Number.isNaN(askedAt.getTime()) || !log.question) {
      console.warn("skip (不正な行):", JSON.stringify(log).slice(0, 80));
      continue;
    }

    const exists = await withClearance(CLEARANCE, (tx) =>
      tx.aiQuestion.findFirst({ where: { askedAt, question: log.question }, select: { id: true } })
    );
    if (exists) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`+ ${log.ts.slice(0, 16)} ${log.question.slice(0, 40)}`);
      added++;
      continue;
    }

    await withClearance(CLEARANCE, (tx) =>
      tx.aiQuestion.create({
        data: {
          askedAt,
          question: log.question,
          answer: log.answer ?? "",
          // KV に出典の内訳は無い。件数だけ残す
          citations: [],
          citationCount: log.citation_count ?? 0,
          cached: log.cached === true,
          origin: "kv-backfill",
          expiresAt: expiryFor(askedAt),
        },
      })
    );
    added++;
  }

  console.log(DRY_RUN ? `--dry-run: ${added}件 追加予定 / ${skipped}件 既存` : `${added}件 追加 / ${skipped}件 既存`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
