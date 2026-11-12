/**
 * 今日の発見の食べ物アイコンを作る (#436)。cron (`/api/cron/discovery-icons`) と同じ処理を、まとめて流す。
 *
 * 対象は、分類のある名前のうちアイコンがまだで、外部 AI に出してよいブログに出てくるもの。
 * 作れなかった回数が上限に達した名前は外す (確認ページから作り直す)。1 枚 $0.03 ほど。
 *
 * 書き込みは DIRECT_URL (RLS バイパス)。既定は下見 (対象を並べるだけで OpenAI は呼ばない)、--apply で作る。
 *
 * Usage:
 *   pnpm cli:food-icons                              # 下見: 作る名前を並べる
 *   pnpm cli:food-icons --apply [--limit N]          # 作る (4 枚ずつ並べて)
 *   pnpm cli:food-icons --upload-style <png>         # 画風の基準画像を R2 に置く (最初の 1 回だけ。替えると全部の画風が変わる)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { FOOD_ICON_STYLE_REFERENCE_KEY } from "@/lib/discoveries/icon";
import { autoGenerateFoodIcons, FOOD_ICON_BATCH_SIZE, loadFoodsNeedingIcons } from "@/lib/domain/discovery-icons";
import { isR2Configured, uploadToR2 } from "@/lib/r2";

if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL が未設定です (このスクリプトは RLS バイパス接続が必須)");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const style = argValue("--upload-style");
  if (style) {
    if (!isR2Configured()) throw new Error("R2 が未設定です");
    const url = await uploadToR2(FOOD_ICON_STYLE_REFERENCE_KEY, readFileSync(style), "image/png");
    console.log(`基準画像を置きました: ${url}`);
    return;
  }

  const limit = argValue("--limit") ? Number(argValue("--limit")) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit には 1 以上の整数を渡してください");
  const targets = await loadFoodsNeedingIcons(prisma, limit);
  console.log(`アイコンがまだの名前: ${targets.length} 個`);
  if (!args.includes("--apply")) {
    console.log(targets.map((t) => t.name).join(" / "));
    console.log("(下見です。作るときは --apply)");
    return;
  }

  let generated = 0;
  let remaining = targets.length;
  while (remaining > 0) {
    const r = await autoGenerateFoodIcons(prisma, Math.min(FOOD_ICON_BATCH_SIZE, remaining));
    if (r.attempted === 0) break;
    generated += r.generated;
    remaining -= r.attempted;
    for (const f of r.failed) console.log(`  失敗 ${f.name}: ${f.message}`);
    console.log(`  ${generated} / ${targets.length} 枚`);
  }
  console.log(`作った ${generated} 枚`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
