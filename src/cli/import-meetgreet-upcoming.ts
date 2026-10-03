/**
 * 一度きりの移行: sekai-nina-site の `src/data/meetgreet-upcoming.json` の予告コーデを
 * MeetGreet.previewOutfit / previewSourceAssetIds に移す (#203)。
 *
 * それまで予告コーデはサイト側の JSON を手で書き換えていた。移したあとは Akashic が正で、
 * サイトはビルド時に `GET /api/v1/meetgreets/upcoming` を読む。開催済みの回も
 * 「予告と実際を比べる記録」として移す (サイトには出ない)。
 *
 * Usage:
 *   pnpm cli:import-meetgreet-upcoming --file <meetgreet-upcoming.json>           # 下見 (何もしない)
 *   pnpm cli:import-meetgreet-upcoming --file <meetgreet-upcoming.json> --apply   # 実行
 *
 * - 出典は JSON の `source.blogRef` / `source.talkRef` (全回共通) を使う
 * - 開催日が同じ回が 2 つ以上あると、どちらか決められないので飛ばす
 * - 既に別の予告が入っている回は上書きしない (Akashic 側で書いたものを守る)
 */
import { readFileSync } from "node:fs";
import { prismaInternal } from "@/lib/db";
import { MEETGREET_FORMAT_LABELS } from "@/lib/utils";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const fileIdx = args.indexOf("--file");
const FILE = fileIdx >= 0 ? args[fileIdx + 1] : undefined;

interface UpcomingJson {
  source?: { blogRef?: string; talkRef?: string };
  items?: { date: string; outfit: string }[];
}

async function main() {
  if (!process.env.DIRECT_URL?.trim()) {
    console.error("DIRECT_URL が未設定です (素の DATABASE_URL だと RLS で 0 行になる)");
    process.exit(1);
  }
  if (!FILE) {
    console.error("--file <meetgreet-upcoming.json> を指定してください");
    process.exit(1);
  }

  const json = JSON.parse(readFileSync(FILE, "utf8")) as UpcomingJson;
  const items = json.items ?? [];
  const sourceIds = [json.source?.blogRef, json.source?.talkRef].filter((v): v is string => !!v);

  const assets = await prismaInternal.asset.findMany({ where: { id: { in: sourceIds } }, select: { id: true, title: true } });
  const missing = sourceIds.filter((id) => !assets.some((a) => a.id === id));
  if (missing.length) {
    console.error(`出典のアセットが見つかりません: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`出典: ${assets.map((a) => a.title).join(" / ")}`);

  let written = 0;
  for (const it of items) {
    const rows = await prismaInternal.meetGreet.findMany({
      where: { date: it.date },
      select: { id: true, label: true, format: true, previewOutfit: true },
    });
    if (rows.length !== 1) {
      console.log(`  飛ばす ${it.date}: 開催日が同じ回が ${rows.length} 件あります`);
      continue;
    }
    const row = rows[0];
    if (row.previewOutfit === it.outfit) {
      console.log(`  そのまま ${it.date}: 移行済み`);
      continue;
    }
    if (row.previewOutfit) {
      console.log(`  飛ばす ${it.date}: 別の予告が入っています (「${row.previewOutfit}」)`);
      continue;
    }
    console.log(`  ${APPLY ? "書く" : "書く予定"} ${it.date} ${row.label}${MEETGREET_FORMAT_LABELS[row.format]}: ${it.outfit}`);
    if (APPLY) {
      await prismaInternal.meetGreet.update({
        where: { id: row.id },
        data: { previewOutfit: it.outfit, previewSourceAssetIds: sourceIds },
      });
    }
    written++;
  }

  console.log(APPLY ? `${written} 回分を書きました` : `${written} 回分を書く予定です (--apply で実行)`);
  await prismaInternal.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
