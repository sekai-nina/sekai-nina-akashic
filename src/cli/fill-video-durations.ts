/**
 * 動画の長さ (Asset.durationSec) を Google Drive の videoMediaMetadata から埋める。
 *
 * 普段は 15 分ごとの cron (/api/cron/video-durations) が同じ処理を回す。これは既存の動画を一度に埋めるためのもの。
 *
 * Usage:
 *   pnpm cli:fill-video-durations            # 下見 (50 本だけ問い合わせて、書き込まない)
 *   pnpm cli:fill-video-durations --apply    # 残りが無くなるまで書き込む
 */
import { prismaInternal } from "@/lib/db";
import { fillVideoDurations } from "@/lib/domain/video-durations";

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.DIRECT_URL?.trim()) {
    console.error("DIRECT_URL が未設定です (prismaInternal が DATABASE_URL に無言でフォールバックする)");
    process.exit(1);
  }
  if (!APPLY) {
    const r = await fillVideoDurations({ limit: 50, budgetMs: 120_000, apply: false });
    console.log(`下見: 長さあり ${r.filled} / Drive に長さなし ${r.missing} / 一時失敗 ${r.retry} / 対象の残り ${r.remaining}`);
    console.log("下見のみ。--apply で書き込む");
    return;
  }
  for (let pass = 1; ; pass++) {
    const r = await fillVideoDurations({ limit: 1000, budgetMs: 10 * 60_000 });
    console.log(`${pass} 回目: 保存 ${r.filled} / 長さなし ${r.missing} / 次へ ${r.retry} / 残り ${r.remaining} / 長さ不明 ${r.unknown}`);
    if (r.remaining === 0 || r.filled + r.missing === 0) break;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prismaInternal.$disconnect());
