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

import { PrismaClient, DataSourceKind, ItemRule } from "@prisma/client";
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
  itemRule?: ItemRule;
  publisherPattern?: string | null;
  titlePattern?: string | null;
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

// パターンは SourceRecord への SQL LIKE。publisherPattern/titlePattern とも `|` 区切りで
// 複数パターン（OR）を書ける（v2.2）。publisher/title は末尾に改行が入る行があるため前方一致 `%` で吸収する。
// 詳細な根拠は docs/coverage-design.md §2「ソース設定（v2.2 シード）」を参照。
const DATA_SOURCES: DataSourceSeed[] = [
  {
    key: "blog",
    name: "公式ブログ",
    kind: "blog",
    itemRule: "blog_url",
    publisherPattern: "日向坂46公式ブログ%",
  },
  {
    key: "talk",
    name: "トーク（メッセージ）",
    kind: "talk",
    itemRule: "talk_date",
    publisherPattern: "Talk (Sony Music)%",
  },
  // 日向坂で会いましょう: 番号のみ表記(#362等)と【配信】表記の2形式。
  // 番号のみは末尾%なしの完全長マッチ（#4__% だとひななり「#4 企画名」を誤って拾う）。
  // 実DB検証(2026-07-12): Lemino 109 URL が hinaai 57 + ninarimashou 52 に重複0・取りこぼし0で分割。
  {
    key: "hinaai",
    name: "日向坂で会いましょう",
    kind: "tv",
    itemRule: "source_url",
    publisherPattern: "Lemino%",
    titlePattern: "【%配信】#%|%日向坂で会いましょう%|#3__|#4__|#3__\n|#4__\n",
  },
  // 日向坂になりましょう: 「#N 企画名」形式（#0〜26）と「日向坂になりましょう【…】#N」形式
  {
    key: "ninarimashou",
    name: "日向坂になりましょう",
    kind: "tv",
    itemRule: "source_url",
    publisherPattern: "Lemino%",
    titlePattern: "#_ %|#__ %|%日向坂になりましょう%",
  },
  {
    key: "hinachan",
    name: "日向坂ちゃんねる",
    kind: "youtube",
    itemRule: "source_url",
    publisherPattern: "YouTube%",
    titlePattern: "日向坂ちゃんねる%",
  },
  {
    key: "official_ch",
    name: "日向坂46公式チャンネル",
    kind: "youtube",
    itemRule: "source_url",
    publisherPattern: "YouTube%",
    titlePattern: "日向坂46公式チャンネル%",
  },
  // 雑誌: 誌名=publisher。新誌が来たら設定タブで追記
  {
    key: "magazine",
    name: "雑誌",
    kind: "magazine",
    itemRule: "source_url",
    publisherPattern:
      "EX大衆%|BRODY%|週刊少年チャンピオン%|グラビアチャンピオン%|Ray%|BUBKA%|B.L.T.%",
  },
  // 以下は Akashic にアセット未取込のため manual（取込が始まったら設定タブで導出規則を設定）。
  { key: "instagram", name: "Instagram", kind: "sns" },
  { key: "tiktok", name: "TikTok", kind: "sns" },
  { key: "x_official", name: "X（公式）", kind: "sns" },
  { key: "showroom", name: "SHOWROOM", kind: "sns" },
  { key: "radio", name: "ラジオ（radiko）", kind: "radio" },
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
      // 既存行の itemRule/publisherPattern/titlePattern も更新する（再実行で規則を反映）。
      update: {
        name: d.name,
        kind: d.kind,
        sortOrder: (i + 1) * 10,
        itemRule: d.itemRule ?? "manual",
        publisherPattern: d.publisherPattern ?? null,
        titlePattern: d.titlePattern ?? null,
      },
      create: {
        key: d.key,
        name: d.name,
        kind: d.kind,
        sortOrder: (i + 1) * 10,
        itemRule: d.itemRule ?? "manual",
        publisherPattern: d.publisherPattern ?? null,
        titlePattern: d.titlePattern ?? null,
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
