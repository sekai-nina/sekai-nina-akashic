/**
 * ILIKE と PGroonga (&@) のヒット集合が一致するかを実データで突き合わせる。
 *
 * 検索を pg_trgm + ILIKE から PGroonga に置き換えた (Issue #31) 際、
 * トークナイザの選択で取りこぼしや余計なヒットが出ないことを確認するためのもの。
 * マイグレーション適用直後と、トークナイザ設定を変えたときに回す。
 *
 * 差分は SQL 側で EXCEPT を取って件数だけ返す。全 ID を引くと 1 語で数万行の
 * 転送になり egress を無駄に食うため。食い違った場合だけ例を 5 件引く。
 *
 * 比較する対は 2 種類ある:
 *   [同一列]   ILIKE と &@ を同じ列に当てた結果。トークナイザ由来の差だけが出る
 *   [旧実装比] 置き換え前の検索条件との差。AssetText は content と
 *              normalizedContent の両方を OR で見ていたのを normalizedContent
 *              一本に絞ったので、ここには意図した差が出うる
 *
 * Usage:
 *   pnpm cli:verify-pgroonga                 # 既定のキーワード群
 *   pnpm cli:verify-pgroonga 坂井新奈 ミーグリ  # キーワードを指定
 */

import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { normalizeText } from "../lib/utils";

// RLS を挟まず全データで意味論を比べたいので DIRECT_URL (postgres) で繋ぐ
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

/** 人名・曲名・1文字・英数字・半角カナ・記号・絵文字と、想定される入力の幅を一通り */
const DEFAULT_KEYWORDS = [
  "にぃたん",
  "坂井新奈",
  "ただ隣で笑っていて",
  "の",
  "日向坂46",
  "Hinatazaka",
  "hinatazaka",
  "ﾆｨﾀﾝ",
  "ヒナタザカ",
  "2024",
  "MV",
  "ブログ",
  "ミーグリ",
  "！",
  "#",
];

/**
 * ILIKE の基準値を取るとき、列をそのまま書いてはいけない。
 *
 * PGroonga は自分のインデックスで ILIKE も処理するため、インデックスを張った
 * 列に素で ILIKE を当てると「PGroonga 経由の ILIKE」が返り、比較の基準として
 * 使えない (トークナイザ設定を間違えると基準値ごと同じ方向にズレて、差分が
 * 出ないまま両方壊れる)。列を式で包むとインデックスが使えなくなり、
 * PostgreSQL 本来の ILIKE になる。
 */
const raw = (column: Prisma.Sql) => Prisma.sql`(${column} || '')`;

interface Comparison {
  label: string;
  /** 置き換え前の条件 */
  before: (term: string, normalized: string) => Prisma.Sql;
  /** 置き換え後の条件 */
  after: (term: string, normalized: string) => Prisma.Sql;
  /** 差分の例を出すときに表示する列 */
  sample: Prisma.Sql;
  /**
   * 取りこぼしを失敗として扱うか。
   *
   * 同じ列どうしの比較では、取りこぼしはトークナイザ設定のミスを意味するので
   * 失敗にする (unify_symbol を有効にしたまま記号を取りこぼした事例がある)。
   * 逆に「余計なヒット」は NormalizerNFKC130 が全角/半角を畳むぶんで、
   * 意図した改善なので失敗にしない。
   */
  strict: boolean;
}

const COMPARISONS: Comparison[] = [
  {
    label: "Asset.title",
    before: (t) =>
      Prisma.sql`SELECT a."id" FROM "Asset" a WHERE ${raw(Prisma.sql`a."title"`)} ILIKE ${`%${t}%`}`,
    after: (t) => Prisma.sql`SELECT a."id" FROM "Asset" a WHERE a."title" &@ ${t}`,
    sample: Prisma.sql`SELECT a."id"::text AS id, a."title" AS text FROM "Asset" a WHERE a."id" = x.id`,
    strict: true,
  },
  {
    label: "Asset.description",
    before: (t) =>
      Prisma.sql`SELECT a."id" FROM "Asset" a WHERE ${raw(Prisma.sql`a."description"`)} ILIKE ${`%${t}%`}`,
    after: (t) => Prisma.sql`SELECT a."id" FROM "Asset" a WHERE a."description" &@ ${t}`,
    sample: Prisma.sql`SELECT a."id"::text AS id, a."description" AS text FROM "Asset" a WHERE a."id" = x.id`,
    strict: true,
  },
  {
    label: "Asset.messageBodyPreview",
    before: (t) =>
      Prisma.sql`SELECT a."id" FROM "Asset" a WHERE ${raw(Prisma.sql`a."messageBodyPreview"`)} ILIKE ${`%${t}%`}`,
    after: (t) => Prisma.sql`SELECT a."id" FROM "Asset" a WHERE a."messageBodyPreview" &@ ${t}`,
    sample: Prisma.sql`SELECT a."id"::text AS id, a."messageBodyPreview" AS text FROM "Asset" a WHERE a."id" = x.id`,
    strict: true,
  },
  {
    // 同一列どうし。トークナイザ由来の差だけを見る
    label: "AssetText.normalizedContent [同一列]",
    before: (_t, n) =>
      Prisma.sql`SELECT DISTINCT t."assetId" AS id FROM "AssetText" t WHERE ${raw(Prisma.sql`t."normalizedContent"`)} ILIKE ${`%${n}%`}`,
    after: (_t, n) =>
      Prisma.sql`SELECT DISTINCT t."assetId" AS id FROM "AssetText" t WHERE t."normalizedContent" &@ ${n}`,
    sample: Prisma.sql`SELECT a."id"::text AS id, a."title" AS text FROM "Asset" a WHERE a."id" = x.id`,
    strict: true,
  },
  {
    // 旧実装は content と normalizedContent の両方を OR で見ていた。
    // ここの差は「正規化列一本に絞った」ぶんで、意図した差が出うる
    label: "AssetText 本文 [旧実装比]",
    before: (t, n) =>
      Prisma.sql`SELECT DISTINCT t."assetId" AS id FROM "AssetText" t
        WHERE ${raw(Prisma.sql`t."content"`)} ILIKE ${`%${t}%`}
           OR ${raw(Prisma.sql`t."normalizedContent"`)} ILIKE ${`%${n}%`}`,
    after: (_t, n) =>
      Prisma.sql`SELECT DISTINCT t."assetId" AS id FROM "AssetText" t WHERE t."normalizedContent" &@ ${n}`,
    sample: Prisma.sql`SELECT a."id"::text AS id, a."title" AS text FROM "Asset" a WHERE a."id" = x.id`,
    // 素の content ブランチを落としたぶんの取りこぼしは意図したもの (画像
    // プレースホルダ {{IMG:...}} の内部 ID への偶然の一致など) なので失敗にしない
    strict: false,
  },
];

async function countOf(query: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>(
    Prisma.sql`SELECT count(*)::int AS n FROM (${query}) q`
  );
  return rows[0].n;
}

/** a にあって b に無い件数 */
async function countOnlyIn(a: Prisma.Sql, b: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>(
    Prisma.sql`SELECT count(*)::int AS n FROM ((${a}) EXCEPT (${b})) d`
  );
  return rows[0].n;
}

async function samplesOnlyIn(
  a: Prisma.Sql,
  b: Prisma.Sql,
  sample: Prisma.Sql
): Promise<Array<{ id: string; text: string | null }>> {
  return prisma.$queryRaw<Array<{ id: string; text: string | null }>>(
    Prisma.sql`
      SELECT s.id, s.text
      FROM ((${a}) EXCEPT (${b})) x
      CROSS JOIN LATERAL (${sample}) s
      LIMIT 5`
  );
}

function preview(text: string | null, keyword: string): string {
  if (!text) return "(null)";
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
  const start = Math.max(0, idx - 30);
  const slice = text.slice(start, start + 100).replace(/\s+/g, " ");
  return (start > 0 ? "…" : "") + slice + (start + 100 < text.length ? "…" : "");
}

async function main() {
  const keywords = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const targets = keywords.length > 0 ? keywords : DEFAULT_KEYWORDS;

  let mismatches = 0;

  for (const keyword of targets) {
    const normalized = normalizeText(keyword);
    console.log(`\n=== ${keyword}${normalized !== keyword ? ` (正規化: ${normalized})` : ""} ===`);

    for (const cmp of COMPARISONS) {
      const before = cmp.before(keyword, normalized);
      const after = cmp.after(keyword, normalized);

      const [beforeCount, afterCount, lostCount, gainedCount] = await Promise.all([
        countOf(before),
        countOf(after),
        countOnlyIn(before, after),
        countOnlyIn(after, before),
      ]);

      const identical = lostCount === 0 && gainedCount === 0;
      const failed = cmp.strict && lostCount > 0;
      if (failed) mismatches++;

      console.log(
        `  ${identical ? "✓" : failed ? "✗" : "△"} ${cmp.label.padEnd(34)} ` +
          `旧=${String(beforeCount).padStart(6)} 新=${String(afterCount).padStart(6)}` +
          (identical ? "" : `  取りこぼし=${lostCount} 余計なヒット=${gainedCount}`)
      );

      if (identical) continue;

      if (lostCount > 0) {
        const rows = await samplesOnlyIn(before, after, cmp.sample);
        for (const r of rows) console.log(`      [取りこぼし] ${r.id} ${preview(r.text, keyword)}`);
      }
      if (gainedCount > 0) {
        const rows = await samplesOnlyIn(after, before, cmp.sample);
        for (const r of rows) console.log(`      [余計なヒット] ${r.id} ${preview(r.text, keyword)}`);
      }
    }
  }

  console.log(
    mismatches === 0
      ? `\n✓ 取りこぼしなし (${targets.length} キーワード × ${COMPARISONS.length} 条件)` +
          `\n  △ は NFKC 正規化で拾えるようになったぶん / 意図した条件変更で、失敗ではない`
      : `\n✗ ${mismatches} 件の条件で取りこぼしあり — トークナイザ設定を疑うこと`
  );
  if (mismatches > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
