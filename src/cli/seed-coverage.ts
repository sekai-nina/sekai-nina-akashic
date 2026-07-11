/**
 * 収集カバレッジの初期シード — Lens 9 件・DataSource 12 件を key で冪等 upsert する。
 * Coverage セル（観点 × ソースの組み合わせ）は作らない。未着手は「行なし」で表現し、
 * UI から明示的に tracked / not_applicable を作る。
 *
 * 書き込みは DIRECT_URL（postgres ロール / RLS バイパス）で行う。
 * 再実行しても既存行を name/description/kind/sortOrder で更新するだけ（key は不変）。
 *
 * Usage:
 *   pnpm cli:seed-coverage
 */

import { PrismaClient, DataSourceKind } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface LensSeed {
  key: string;
  name: string;
  description: string;
}

interface DataSourceSeed {
  key: string;
  name: string;
  kind: DataSourceKind;
}

// 設計書 §4 の順序を sortOrder に反映（10 刻み）。
const LENSES: LensSeed[] = [
  { key: "leisure", name: "レジャー（おでかけ）", description: "誰かと出かけた出来事。場所・同行者・行動の事実" },
  { key: "meetgreet", name: "ミーグリ", description: "オンライン/リアルミーグリの実施回・レポ・本人感想" },
  { key: "live", name: "ライブ", description: "参加・出演したライブ、披露曲、現場での出来事" },
  { key: "input", name: "インプット", description: "観た映画・ドラマ・読んだ本などの摂取コンテンツ" },
  { key: "food", name: "食べたもの", description: "食べた・飲んだものの記録" },
  { key: "possessions", name: "所有物", description: "私物・愛用品・購入したもの" },
  { key: "nina_memo", name: "新奈メモ", description: "坂井新奈に関する細かい知識・属性・エピソード" },
  { key: "good_words", name: "良い言葉", description: "ブログ・トーク内の印象的な言葉・名言" },
  { key: "funny_replies", name: "面白い返答", description: "ミーグリ・配信等での面白い返答・やりとり" },
];

const DATA_SOURCES: DataSourceSeed[] = [
  { key: "blog", name: "公式ブログ", kind: "blog" },
  { key: "talk", name: "トーク（メッセージ）", kind: "talk" },
  { key: "hinaai", name: "日向坂で会いましょう", kind: "tv" },
  { key: "hinachan", name: "日向坂ちゃんねる", kind: "youtube" },
  { key: "ninarimashou", name: "日向坂になりましょう", kind: "tv" },
  { key: "official_ch", name: "日向坂46公式チャンネル", kind: "youtube" },
  { key: "instagram", name: "Instagram", kind: "sns" },
  { key: "tiktok", name: "TikTok", kind: "sns" },
  { key: "x_official", name: "X（公式）", kind: "sns" },
  { key: "showroom", name: "SHOWROOM", kind: "sns" },
  { key: "radio", name: "ラジオ（radiko）", kind: "radio" },
  { key: "magazine", name: "雑誌", kind: "magazine" },
];

async function main() {
  if (!process.env.DIRECT_URL) {
    console.error("DIRECT_URL is required (postgres role, bypasses RLS)");
    process.exit(1);
  }

  let lensCount = 0;
  for (let i = 0; i < LENSES.length; i++) {
    const l = LENSES[i];
    await prisma.lens.upsert({
      where: { key: l.key },
      update: { name: l.name, description: l.description, sortOrder: (i + 1) * 10 },
      create: {
        key: l.key,
        name: l.name,
        description: l.description,
        sortOrder: (i + 1) * 10,
      },
    });
    lensCount++;
  }

  let dsCount = 0;
  for (let i = 0; i < DATA_SOURCES.length; i++) {
    const d = DATA_SOURCES[i];
    await prisma.dataSource.upsert({
      where: { key: d.key },
      update: { name: d.name, kind: d.kind, sortOrder: (i + 1) * 10 },
      create: {
        key: d.key,
        name: d.name,
        kind: d.kind,
        sortOrder: (i + 1) * 10,
      },
    });
    dsCount++;
  }

  console.log(`Seeded ${lensCount} lenses / ${dsCount} data sources (idempotent by key).`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
