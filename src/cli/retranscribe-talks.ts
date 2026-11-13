/**
 * 文字起こし済みの坂井新奈のトークを gpt-transcribe でやり直す (Groq の whisper-large-v3 から切り替えたとき用)。
 *
 * - 対象は `--before` より前に文字起こしした、失敗していないトーク。やり直すと `transcribedAt` が今になるので、
 *   途中で止まっても同じ `--before` で流し直せば残りだけを拾う
 * - 旧本文は `addTextRevision` で版に残る。抜粋 (クリップ・記事の出典) の範囲も探し直す
 * - **人が手で直した本文 (文字起こしのあとに本文が更新されたもの) は飛ばす**
 * - 喋っていなかった (本文が空になった) ときは既存の本文を消さない (cron と同じ)
 *
 * Usage:
 *   pnpm cli:retranscribe-talks                                   # 下見 (何もしない)
 *   pnpm cli:retranscribe-talks --apply --before 2026-11-14T12:00:00+09:00
 */
import "dotenv/config";
import { prismaInternal } from "@/lib/db";
import { ASSET_SELECT, talkWhere, transcribeInternal, type TargetAsset } from "@/lib/domain/transcribe";
import { isTranscribeConfigured } from "@/lib/transcribe/openai";

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 4;
/** 文字起こしのあとにこれより遅れて本文が更新されていたら、人の手直しとみなす */
const EDIT_GRACE_MS = 10_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!process.env.DIRECT_URL?.trim()) {
    console.error("DIRECT_URL が未設定です (prismaInternal が DATABASE_URL に無言でフォールバックする)");
    process.exit(1);
  }
  if (!isTranscribeConfigured()) {
    console.error("OPENAI_API_KEY が未設定です");
    process.exit(1);
  }
  const beforeArg = arg("--before");
  if (APPLY && !beforeArg) {
    console.error("--apply には --before <ISO 日時> が要ります (流し直したときに同じものを 2 回やらないため)");
    process.exit(1);
  }
  const before = beforeArg ? new Date(beforeArg) : new Date();
  if (Number.isNaN(before.getTime())) {
    console.error(`--before を日時として読めません: ${beforeArg}`);
    process.exit(1);
  }

  const rows = await prismaInternal.asset.findMany({
    where: { ...talkWhere(), transcribedAt: { lt: before }, transcribeError: null },
    select: {
      ...ASSET_SELECT,
      title: true,
      transcribedAt: true,
      texts: { where: { textType: "transcript" }, select: { updatedAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const edited = rows.filter((r) =>
    r.texts.some((t) => t.updatedAt.getTime() > r.transcribedAt!.getTime() + EDIT_GRACE_MS),
  );
  const targets = rows.filter((r) => !edited.includes(r));
  const withText = targets.filter((r) => r.texts.length > 0).length;

  console.log(`--before ${before.toISOString()}`);
  console.log(`対象 ${targets.length} 件 (本文あり ${withText} 件 / 本文なし ${targets.length - withText} 件)`);
  console.log(`手直しされているので飛ばす ${edited.length} 件`);
  for (const r of edited) console.log(`  - ${r.title} (${r.id})`);
  if (!APPLY) {
    console.log("下見のみ。--apply --before <上の日時> でやり直す");
    return;
  }

  const counts = { done: 0, empty: 0, failed: 0, retry: 0 };
  let stopped = false;
  let next = 0;
  async function worker() {
    while (!stopped && next < targets.length) {
      const asset: TargetAsset & { title: string } = targets[next++];
      const outcome = await transcribeInternal(asset);
      if (outcome.kind === "retry") {
        counts.retry++;
        console.warn(`  再試行 ${asset.title} (${asset.id}): ${outcome.error}`);
        if (outcome.stopBatch) stopped = true;
      } else if (outcome.kind === "failed") {
        counts.failed++;
        console.warn(`  失敗 ${asset.title} (${asset.id}): ${outcome.error}`);
      } else if (outcome.text) counts.done++;
      else counts.empty++;
      const n = counts.done + counts.empty + counts.failed + counts.retry;
      if (n % 25 === 0) console.log(`  ${n} / ${targets.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(
    `保存 ${counts.done} / 喋っていない ${counts.empty} / 失敗 ${counts.failed} / 次の回へ ${counts.retry}${stopped ? " (打ち切り)" : ""}`,
  );
  if (counts.retry > 0) console.log(`残りは同じ --before ${before.toISOString()} で流し直す`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prismaInternal.$disconnect());
